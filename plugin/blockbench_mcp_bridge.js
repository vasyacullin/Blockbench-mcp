/*
 * Blockbench MCP Bridge
 * ---------------------
 * Hosts a local TCP control server inside the running Blockbench desktop app so
 * an external MCP server (mcp/server) can drive Blockbench on behalf of an LLM:
 * create projects, build models, paint textures, set up UVs, animate, and render.
 *
 * Transport: raw TCP (Node 'net'), newline-delimited JSON.
 *   On connect the CLIENT must first send an auth handshake:
 *     client -> {"type":"auth","token":"<token>"}
 *     server -> {"type":"auth_ok","protocol":1}  |  {"type":"auth_err","message":...}
 *   Then, per request:
 *     client -> {"type":"req","id":<n>,"method":<string>,"params":<object>}
 *     server -> {"type":"res","id":<n>,"ok":true,"result":<any>}
 *             | {"type":"res","id":<n>,"ok":false,"error":{message,stack}}
 *   The server also sends {"type":"hello",...} immediately on connect.
 *
 * SECURITY: the server binds 127.0.0.1 only AND requires a shared token (shown
 * via "MCP Bridge: Status"). The very first line on a connection must be a valid
 * auth handshake or the socket is dropped — this blocks browser drive-by/CSRF
 * (a cross-origin fetch always sends an HTTP preamble first, which fails to parse
 * and is rejected). `execute_script` runs arbitrary code, so treat the token like
 * a password.
 *
 * The Blockbench app uses nodeIntegration; plugins get a permission-scoped
 * `require`. 'net' and 'string_decoder' are whitelisted ('http' is NOT — hence a
 * raw TCP protocol instead of HTTP/WebSocket). 'net' prompts for permission once.
 *
 * IMPORTANT: when sideloaded via "Load Plugin from File", Blockbench derives the
 * plugin id from the FILE NAME. This file MUST be named blockbench_mcp_bridge.js
 * so it matches PLUGIN_ID below; otherwise Plugin.register can't find it and
 * onload never runs.
 *
 * Install: Blockbench > Plugins > Load Plugin from File > pick this file.
 */
(function () {
	'use strict';

	const PLUGIN_ID = 'blockbench_mcp_bridge'; // MUST equal the filename (minus .js)
	const PROTOCOL = 1;
	const DEFAULT_PORT = 19888;

	let net = null;
	let StringDecoder = null;
	let actions = [];

	function log() {
		console.log.apply(console, ['[MCP Bridge]'].concat([].slice.call(arguments)));
	}

	function getPort() {
		let stored = parseInt(localStorage.getItem('mcp_bridge_port'), 10);
		return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_PORT;
	}

	function getToken() {
		let t = localStorage.getItem('mcp_bridge_token');
		if (!t) {
			let arr = new Uint8Array(24);
			(window.crypto || window.msCrypto).getRandomValues(arr);
			t = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
			localStorage.setItem('mcp_bridge_token', t);
		}
		return t;
	}

	// ======================================================================
	//  Resolution & utility helpers
	// ======================================================================

	function requireProject() {
		if (!Project) throw new Error('No project is open. Create one first with create_project.');
	}

	function resolveElement(ref) {
		if (ref === undefined || ref === null) return undefined;
		let byUuid = (typeof OutlinerNode !== 'undefined' && OutlinerNode.uuids) ? OutlinerNode.uuids[ref] : null;
		if (byUuid && byUuid.faces !== undefined) return byUuid; // element (cube/mesh) — has faces
		return Outliner.elements.find(e => e.uuid === ref || e.name === ref);
	}

	function resolveGroup(ref) {
		if (ref === undefined || ref === null) return undefined;
		let byUuid = (typeof OutlinerNode !== 'undefined' && OutlinerNode.uuids) ? OutlinerNode.uuids[ref] : null;
		if (byUuid instanceof Group) return byUuid;
		return Group.all.find(g => g.uuid === ref || g.name === ref);
	}

	function resolveNode(ref) {
		if (ref === undefined || ref === null) return undefined;
		let byUuid = (typeof OutlinerNode !== 'undefined' && OutlinerNode.uuids) ? OutlinerNode.uuids[ref] : null;
		if (byUuid) return byUuid;
		return Outliner.elements.find(e => e.uuid === ref || e.name === ref) ||
			Group.all.find(g => g.uuid === ref || g.name === ref);
	}

	function resolveTexture(ref) {
		if (ref === undefined || ref === null || ref === '') {
			return Texture.getDefault() || Texture.selected || Texture.all[0];
		}
		let tex = Texture.all.find(t => t.uuid === ref || t.name === ref);
		if (!tex) throw new Error('Texture not found: ' + ref);
		return tex;
	}

	function resolveAnimation(ref) {
		if (ref === undefined || ref === null || ref === '') {
			return Animation.selected || Animation.all[0];
		}
		let a = Animation.all.find(an => an.uuid === ref || an.name === ref);
		if (!a) throw new Error('Animation not found: ' + ref);
		return a;
	}

	function toRgba(colorStr) {
		let c = new tinycolor(colorStr);
		if (!c.isValid()) throw new Error('Invalid color: ' + colorStr);
		let rgb = c.toRgb(); // {r,g,b (0-255), a (0-1)}
		return { r: rgb.r, g: rgb.g, b: rgb.b, a: typeof rgb.a === 'number' ? rgb.a : 1 };
	}

	function rgbaCss(rgba) {
		return 'rgba(' + rgba.r + ',' + rgba.g + ',' + rgba.b + ',' + rgba.a + ')';
	}

	function vec3(arr, fallback) {
		if (!arr) return fallback ? fallback.slice() : undefined;
		return [Number(arr[0]) || 0, Number(arr[1]) || 0, Number(arr[2]) || 0];
	}

	function ensureAnimationFormat() {
		if (!Format.animation_mode) throw new Error('The current format does not support animations. Create a project with an animation-capable format (e.g. bedrock, modded_entity).');
	}

	function ensureAnimateMode() {
		if (typeof Animator !== 'undefined' && !Animator.open) {
			if (typeof Modes !== 'undefined' && Modes.options && Modes.options.animate) {
				Modes.options.animate.select();
			}
		}
	}

	// Run a mutation wrapped in Undo, cancelling the edit if the body throws so we
	// never leave a dangling Undo.current_save. The body receives a `finish`
	// callback used to set the finish-aspects (e.g. the freshly created element).
	function withUndo(initAspects, name, body) {
		Undo.initEdit(initAspects);
		let finishAspects;
		try {
			let result = body(a => { finishAspects = a; });
			Undo.finishEdit(name, finishAspects);
			return result;
		} catch (e) {
			try { if (typeof Undo.cancelEdit === 'function') Undo.cancelEdit(); } catch (_) {}
			throw e;
		}
	}

	function decodeImage(dataUrl) {
		return new Promise((resolve, reject) => {
			let img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error('Failed to decode image data'));
			img.src = dataUrl;
		});
	}

	function arrayBufferToBase64(buf) {
		if (typeof Buffer !== 'undefined') return Buffer.from(buf).toString('base64');
		let bytes = new Uint8Array(buf), binary = '';
		for (let i = 0; i < bytes.length; i += 0x8000) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		}
		return btoa(binary);
	}

	function readtypeFor(name) {
		let ext = String(name || '').split('.').pop().toLowerCase();
		if (['png', 'tga', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(ext)) return 'image';
		if (['glb', 'fbx'].includes(ext)) return 'buffer';
		return 'text';
	}

	// JSON-safe serialization of an arbitrary script return value.
	function serializeSafe(value) {
		const seen = new WeakSet();
		function clean(v, depth) {
			if (v === null || v === undefined) return v;
			let t = typeof v;
			if (t === 'number' || t === 'string' || t === 'boolean') return v;
			if (t === 'bigint') return v.toString();
			if (t === 'function') return '[function ' + (v.name || 'anonymous') + ']';
			if (t === 'symbol') return v.toString();
			if (depth > 6) return '[max depth]';
			if (Array.isArray(v)) {
				if (seen.has(v)) return '[circular]';
				seen.add(v);
				return v.slice(0, 1000).map(x => clean(x, depth + 1));
			}
			if (t === 'object') {
				if (v.uuid && (v instanceof Cube || v instanceof Group || v instanceof Mesh ||
					(typeof Texture !== 'undefined' && v instanceof Texture) ||
					(typeof Animation !== 'undefined' && v instanceof Animation))) {
					return { uuid: v.uuid, name: v.name, type: v.type || v.constructor.name };
				}
				if (seen.has(v)) return '[circular]';
				seen.add(v);
				let out = {};
				for (let k of Object.keys(v).slice(0, 200)) {
					try { out[k] = clean(v[k], depth + 1); } catch (e) { out[k] = '[unreadable]'; }
				}
				return out;
			}
			return String(v);
		}
		return clean(value, 0);
	}

	function elementSummary(el) {
		let out = {
			uuid: el.uuid, type: el.type, name: el.name,
			parent: (el.parent === 'root' || !el.parent) ? 'root' : el.parent.uuid,
			visibility: el.visibility,
		};
		if (el.origin) out.origin = el.origin.slice();
		if (el.rotation) out.rotation = el.rotation.slice();
		if (el.from) out.from = el.from.slice();
		if (el.to) out.to = el.to.slice();
		if (typeof el.size === 'function') { try { out.size = el.size(); } catch (e) {} }
		if (el instanceof Mesh) {
			out.vertex_count = Object.keys(el.vertices || {}).length;
			out.face_count = Object.keys(el.faces || {}).length;
		} else if (el.faces) {
			out.faces = Object.keys(el.faces);
		}
		return out;
	}

	function refreshNode(n) {
		if (n.preview_controller) {
			n.preview_controller.updateTransform(n);
			if (typeof n.preview_controller.updateGeometry === 'function') n.preview_controller.updateGeometry(n);
		}
		if (n.children) n.children.forEach(refreshNode);
	}

	// Bounding box over ALL elements (so render framing is independent of selection).
	function modelBounds() {
		let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], any = false;
		const ext = (p) => { for (let i = 0; i < 3; i++) { let v = Number(p[i]) || 0; if (v < min[i]) min[i] = v; if (v > max[i]) max[i] = v; } any = true; };
		for (let el of Outliner.elements) {
			if (el.from && el.to) { ext(el.from); ext(el.to); }
			else if (el.vertices) { let o = el.origin || [0, 0, 0]; for (let k in el.vertices) { let v = el.vertices[k]; ext([v[0] + o[0], v[1] + o[1], v[2] + o[2]]); } }
			else if (el.origin) ext(el.origin);
		}
		if (!any) { min = [-8, -8, -8]; max = [8, 8, 8]; }
		return {
			center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
			size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
		};
	}

	// ======================================================================
	//  Command handlers
	// ======================================================================

	const handlers = {

		// ---------- meta ----------
		status() {
			let result = {
				connected: true, app: 'blockbench',
				version: (typeof Blockbench !== 'undefined') ? Blockbench.version : undefined,
				protocol: PROTOCOL,
				mode: (typeof Modes !== 'undefined' && Modes.selected) ? Modes.selected.id : undefined,
				project: null,
			};
			if (Project) {
				result.project = {
					uuid: Project.uuid,
					name: Project.getDisplayName ? Project.getDisplayName() : Project.name,
					format: Format ? Format.id : undefined,
					texture_width: Project.texture_width,
					texture_height: Project.texture_height,
					counts: {
						elements: Outliner.elements.length, groups: Group.all.length,
						textures: Texture.all.length,
						animations: (typeof Animation !== 'undefined') ? Animation.all.length : 0,
					},
				};
			}
			return result;
		},

		// ---------- project ----------
		list_formats() {
			return Object.values(Formats).map(f => ({
				id: f.id, name: f.name, category: f.category, target: f.target,
				codec: f.codec ? f.codec.id : null,
				extension: f.codec ? f.codec.extension : null,
				animation_mode: !!f.animation_mode, bone_rig: !!f.bone_rig,
				meshes: !!f.meshes, box_uv: !!f.box_uv,
			}));
		},

		create_project(p) {
			let format = Formats[p.format];
			if (!format) throw new Error('Unknown format "' + p.format + '". Use list_formats to see valid ids.');
			newProject(format);
			if (!Project) throw new Error('Failed to create project.');
			if (p.name) Project.name = p.name;
			if (p.texture_width) Project.texture_width = parseInt(p.texture_width, 10);
			if (p.texture_height) Project.texture_height = parseInt(p.texture_height, 10);
			return { uuid: Project.uuid, format: Format.id, name: Project.name };
		},

		get_project() {
			requireProject();
			return {
				uuid: Project.uuid,
				name: Project.getDisplayName ? Project.getDisplayName() : Project.name,
				format: Format.id, format_name: Format.name,
				texture_width: Project.texture_width, texture_height: Project.texture_height,
				box_uv: Project.box_uv,
				save_path: Project.save_path || null, export_path: Project.export_path || null,
				counts: {
					elements: Outliner.elements.length, groups: Group.all.length,
					textures: Texture.all.length,
					animations: (typeof Animation !== 'undefined') ? Animation.all.length : 0,
				},
			};
		},

		save_project(p) {
			requireProject();
			if (!p.path) throw new Error('save_project requires a "path".');
			if (typeof saveTextures === 'function') { try { saveTextures(true); } catch (e) {} }
			Project.save_path = p.path;
			Codecs.project.write(Codecs.project.compile(), p.path);
			return { path: p.path, saved: true };
		},

		async export_model(p) {
			requireProject();
			let codec = p.codec ? Codecs[p.codec] : Format.codec;
			if (!codec) throw new Error('No codec available. Specify a codec id (e.g. java_block, bedrock, gltf, obj).');

			// Some codecs (e.g. gltf) mutate the view mode/pose; snapshot & restore.
			let prevViewMode = (typeof BarItems !== 'undefined' && BarItems.view_mode) ? BarItems.view_mode.value : null;
			let compiled;
			try {
				compiled = await Promise.resolve(codec.compile());
			} finally {
				if (prevViewMode != null && BarItems.view_mode && BarItems.view_mode.value !== prevViewMode) {
					try { BarItems.view_mode.set(prevViewMode); } catch (e) {}
				}
			}

			if (p.path) {
				codec.write(compiled, p.path);
				return { path: p.path, codec: codec.id };
			}
			if (typeof compiled === 'string') return { codec: codec.id, content: compiled };
			if (compiled instanceof ArrayBuffer) return { codec: codec.id, encoding: 'base64', content: arrayBufferToBase64(compiled) };
			if (compiled && typeof compiled.arrayBuffer === 'function') {
				let buf = await compiled.arrayBuffer();
				return { codec: codec.id, encoding: 'base64', content: arrayBufferToBase64(buf) };
			}
			return { codec: codec.id, content: JSON.stringify(compiled, null, 2) };
		},

		async load_project(p) {
			let prevUuid = Project ? Project.uuid : null;
			if (p.path) {
				await new Promise((resolve, reject) => {
					let settled = false;
					let to = setTimeout(() => {
						if (!settled) { settled = true; reject(new Error('Timed out reading file (does the path exist and is it readable?): ' + p.path)); }
					}, 20000);
					try {
						Blockbench.read([p.path], { readtype: readtypeFor(p.path) }, files => {
							if (settled) return; settled = true; clearTimeout(to);
							try {
								if (!files || !files[0]) return reject(new Error('Could not read file: ' + p.path));
								loadModelFile(files[0]);
								resolve();
							} catch (e) { reject(e); }
						});
					} catch (e) { if (!settled) { settled = true; clearTimeout(to); reject(e); } }
				});
			} else if (p.content) {
				loadModelFile({ path: p.name || 'model.bbmodel', content: p.content });
			} else {
				throw new Error('load_project requires "path" or "content".');
			}
			let loaded = !!Project && Project.uuid !== prevUuid;
			if (!loaded) throw new Error('Nothing was loaded — the file may be an unsupported format or invalid.');
			return { name: Project.name, format: Format.id, uuid: Project.uuid, loaded: true };
		},

		// ---------- geometry ----------
		add_cube(p) {
			requireProject();
			if (!p.from || !p.to) throw new Error('add_cube requires "from" and "to".');
			return withUndo({ outliner: true, elements: [], selection: true }, 'Add cube (MCP)', (finish) => {
				let cube = new Cube({
					name: p.name || 'cube',
					from: vec3(p.from), to: vec3(p.to),
					origin: vec3(p.origin, [0, 0, 0]), rotation: vec3(p.rotation, [0, 0, 0]),
					uv_offset: p.uv_offset ? [Number(p.uv_offset[0]) || 0, Number(p.uv_offset[1]) || 0] : [0, 0],
					autouv: (p.autouv === 0 || p.autouv === 1 || p.autouv === 2) ? p.autouv : 0,
				}).init();
				if (typeof p.inflate === 'number') cube.inflate = p.inflate;

				let group = p.group ? resolveGroup(p.group) : getCurrentGroup();
				if (group) cube.addTo(group);

				if (!cube.box_uv) cube.mapAutoUV();

				let tex = p.texture ? resolveTexture(p.texture) : (Texture.all.length && Format.single_texture ? Texture.getDefault() : null);
				if (tex) { for (let f in cube.faces) if (cube.faces[f].texture !== null) cube.faces[f].texture = tex.uuid; }

				unselectAllElements();
				cube.select();
				Canvas.updateView({ elements: [cube], element_aspects: { transform: true, geometry: true, faces: true, uv: true } });
				finish({ outliner: true, elements: [cube], selection: true });
				Blockbench.dispatchEvent('add_cube', { object: cube });
				return { uuid: cube.uuid, name: cube.name };
			});
		},

		add_group(p) {
			requireProject();
			return withUndo({ outliner: true, groups: [] }, 'Add group (MCP)', (finish) => {
				let group = new Group({
					name: p.name || (Format.bone_rig ? 'bone' : 'group'),
					origin: vec3(p.origin, [0, 0, 0]), rotation: vec3(p.rotation, [0, 0, 0]),
				}).init();
				let parent = p.parent ? resolveGroup(p.parent) : null;
				if (parent) group.addTo(parent);
				if (group.getTypeBehavior && group.getTypeBehavior('unique_name')) group.createUniqueName();
				Canvas.updateAllBones([group]);
				finish({ outliner: true, groups: [group] });
				Blockbench.dispatchEvent('add_group', { object: group });
				return { uuid: group.uuid, name: group.name };
			});
		},

		add_mesh(p) {
			requireProject();
			if (typeof Mesh === 'undefined' || !Format.meshes) throw new Error('The current format does not support meshes.');
			if (!p.vertices || !p.vertices.length) throw new Error('add_mesh requires "vertices".');
			return withUndo({ outliner: true, elements: [], selection: true }, 'Add mesh (MCP)', (finish) => {
				let mesh = new Mesh({
					name: p.name || 'mesh', vertices: {},
					origin: vec3(p.origin, [0, 0, 0]), rotation: vec3(p.rotation, [0, 0, 0]),
				});
				let vkeys = mesh.addVertices.apply(mesh, p.vertices.map(v => vec3(v)));
				let faces = (p.faces || []).map(face => {
					let verts = face.vertices.map(i => vkeys[i]);
					let uv;
					if (face.uv && face.uv.length) {
						uv = {};
						face.vertices.forEach((vi, idx) => {
							if (face.uv[idx]) uv[vkeys[vi]] = [Number(face.uv[idx][0]) || 0, Number(face.uv[idx][1]) || 0];
						});
					}
					return new MeshFace(mesh, { vertices: verts, uv: uv });
				});
				if (faces.length) mesh.addFaces.apply(mesh, faces);
				mesh.init();

				let group = p.group ? resolveGroup(p.group) : getCurrentGroup();
				if (group) mesh.addTo(group);

				let tex = p.texture ? resolveTexture(p.texture) : (Format.single_texture ? Texture.getDefault() : null);
				if (tex) { for (let f in mesh.faces) mesh.faces[f].texture = tex.uuid; }

				unselectAllElements();
				mesh.select();
				Canvas.updateView({ elements: [mesh], element_aspects: { transform: true, geometry: true, faces: true, uv: true } });
				finish({ outliner: true, elements: [mesh], selection: true });
				Blockbench.dispatchEvent('add_mesh', { object: mesh });
				return { uuid: mesh.uuid, name: mesh.name, vertices: vkeys.length, faces: faces.length };
			});
		},

		edit_element(p) {
			requireProject();
			let el = resolveNode(p.target);
			if (!el) throw new Error('Element not found: ' + p.target);
			let isGroup = el instanceof Group;
			return withUndo(isGroup ? { group: el, outliner: true } : { elements: [el] }, 'Edit element (MCP)', () => {
				if (p.from && el.from) el.from = vec3(p.from);
				if (p.to && el.to) el.to = vec3(p.to);
				if (p.origin && el.origin) el.origin = vec3(p.origin);
				if (p.rotation && el.rotation) el.rotation = vec3(p.rotation);
				if (typeof p.inflate === 'number' && 'inflate' in el) el.inflate = p.inflate;
				if (p.rename) el.name = p.rename;
				if (typeof p.visibility === 'boolean') el.visibility = p.visibility;

				if (el.box_uv === false && typeof el.mapAutoUV === 'function') el.mapAutoUV();
				if (isGroup) {
					Canvas.updateView({ groups: [el] }); // updates bones + visibility
				} else {
					el.preview_controller.updateTransform(el);
					if (typeof el.preview_controller.updateGeometry === 'function') el.preview_controller.updateGeometry(el);
					if (typeof p.visibility === 'boolean') el.preview_controller.updateVisibility(el);
				}
				return { uuid: el.uuid };
			});
		},

		delete_element(p) {
			requireProject();
			let node = resolveNode(p.target);
			if (!node) throw new Error('Element not found: ' + p.target);
			let elements = [], groups = [];
			(function collect(n) {
				if (n instanceof Group) groups.push(n); else elements.push(n);
				if (n.children) n.children.forEach(collect);
			})(node);
			return withUndo({ elements: elements, groups: groups, outliner: true, selection: true }, 'Delete element (MCP)', () => {
				node.remove(false);
				if (typeof TickUpdates !== 'undefined') TickUpdates.selection = true;
				return { removed: true, uuid: p.target };
			});
		},

		duplicate_element(p) {
			requireProject();
			let node = resolveNode(p.target);
			if (!node) throw new Error('Element not found: ' + p.target);
			if (typeof node.duplicate !== 'function') throw new Error('This node type cannot be duplicated via this tool; use execute_script.');
			return withUndo({ outliner: true, elements: [], groups: [], selection: true }, 'Duplicate element (MCP)', (finish) => {
				let dup = node.duplicate();
				let elements = [], groups = [];
				(function collect(n) {
					if (n instanceof Group) groups.push(n); else elements.push(n);
					if (n.children) n.children.forEach(collect);
				})(dup);
				Canvas.updateAll();
				finish({ outliner: true, elements: elements, groups: groups, selection: true });
				return { uuid: dup.uuid, name: dup.name };
			});
		},

		set_parent(p) {
			requireProject();
			let node = resolveNode(p.target);
			if (!node) throw new Error('Element not found: ' + p.target);
			let parent = (p.parent === 'root' || !p.parent) ? 'root' : resolveGroup(p.parent);
			if (parent !== 'root' && !parent) throw new Error('Parent group not found: ' + p.parent);
			return withUndo({ outliner: true, elements: Outliner.elements.slice(), groups: Group.all.slice() }, 'Reparent (MCP)', () => {
				node.addTo(parent, typeof p.index === 'number' ? p.index : -1);
				refreshNode(node);
				Canvas.updateAllBones();
				if (typeof updateSelection === 'function') updateSelection();
				return { uuid: node.uuid, parent: parent === 'root' ? 'root' : parent.uuid };
			});
		},

		list_elements() {
			requireProject();
			return {
				elements: Outliner.elements.map(elementSummary),
				groups: Group.all.map(g => ({
					uuid: g.uuid, name: g.name,
					origin: g.origin ? g.origin.slice() : undefined,
					rotation: g.rotation ? g.rotation.slice() : undefined,
					parent: (g.parent === 'root' || !g.parent) ? 'root' : g.parent.uuid,
					children: (g.children || []).map(c => c.uuid),
				})),
			};
		},

		// ---------- textures / painting ----------
		async create_texture(p) {
			requireProject();
			let w = parseInt(p.width, 10) || Project.texture_width || 16;
			let h = parseInt(p.height, 10) || Project.texture_height || 16;
			let canvas = document.createElement('canvas');
			canvas.width = w; canvas.height = h;
			let ctx = canvas.getContext('2d');
			if (p.fill) { ctx.fillStyle = rgbaCss(toRgba(p.fill)); ctx.fillRect(0, 0, w, h); }
			let dataUrl = canvas.toDataURL('image/png', 1);
			let texture = new Texture({ name: p.name || 'texture', folder: p.folder || '' }).fromDataURL(dataUrl).add(true);
			// Make the texture's working canvas correct & ready synchronously (avoid async-load races).
			let img = await decodeImage(dataUrl);
			texture.width = w; texture.height = h;
			texture.canvas.width = w; texture.canvas.height = h;
			texture.ctx.clearRect(0, 0, w, h);
			texture.ctx.drawImage(img, 0, 0);
			if (typeof texture.fillParticle === 'function') { try { texture.fillParticle(); } catch (e) {} }
			texture.select();
			return { uuid: texture.uuid, name: texture.name, width: w, height: h };
		},

		list_textures() {
			requireProject();
			return Texture.all.map(t => ({
				uuid: t.uuid, name: t.name, width: t.width, height: t.height,
				selected: t === Texture.selected, folder: t.folder, layers_enabled: !!t.layers_enabled,
			}));
		},

		async import_texture(p) {
			requireProject();
			let dataUrl = p.data_url;
			if (!dataUrl && p.base64) dataUrl = 'data:image/png;base64,' + p.base64;
			if (!dataUrl) throw new Error('import_texture requires "data_url" or "base64".');
			let texture = new Texture({ name: p.name || 'imported', folder: p.folder || '' }).fromDataURL(dataUrl).add(true);
			let img = await decodeImage(dataUrl);
			texture.width = img.naturalWidth; texture.height = img.naturalHeight;
			texture.canvas.width = img.naturalWidth; texture.canvas.height = img.naturalHeight;
			texture.ctx.clearRect(0, 0, texture.canvas.width, texture.canvas.height);
			texture.ctx.drawImage(img, 0, 0);
			if (typeof texture.fillParticle === 'function') { try { texture.fillParticle(); } catch (e) {} }
			texture.select();
			return { uuid: texture.uuid, name: texture.name, width: texture.width, height: texture.height };
		},

		fill_texture(p) {
			requireProject();
			let texture = resolveTexture(p.texture);
			if (!texture) throw new Error('No texture to fill. Create one first.');
			let rgba = toRgba(p.color); // validate before opening the edit
			texture.edit(() => {
				let ctx = Painter.current.ctx;
				ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
				ctx.globalCompositeOperation = 'source-over';
				ctx.fillStyle = rgbaCss(rgba);
				ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
			}, { edit_name: 'Fill texture (MCP)' });
			return { uuid: texture.uuid, filled: true };
		},

		paint_rect(p) {
			requireProject();
			let texture = resolveTexture(p.texture);
			if (!texture) throw new Error('No texture. Create one first.');
			let rgba = toRgba(p.color); // validate before the edit
			let x = p.x | 0, y = p.y | 0, w = p.w | 0, h = p.h | 0;
			if (w <= 0 || h <= 0) throw new Error('paint_rect requires positive w and h.');
			let replace = p.blend === 'replace';
			texture.edit(() => {
				let ctx = Painter.current.ctx;
				let off = Painter.current.offset || [0, 0];
				let rx = x - off[0], ry = y - off[1];
				if (replace) {
					let id = new ImageData(w, h);
					let a255 = Math.round(rgba.a * 255);
					for (let i = 0; i < w * h; i++) {
						id.data[i * 4] = rgba.r; id.data[i * 4 + 1] = rgba.g;
						id.data[i * 4 + 2] = rgba.b; id.data[i * 4 + 3] = a255;
					}
					ctx.putImageData(id, rx, ry);
				} else {
					ctx.globalCompositeOperation = 'source-over';
					ctx.fillStyle = rgbaCss(rgba);
					ctx.fillRect(rx, ry, w, h);
				}
			}, { edit_name: 'Paint rectangle (MCP)' });
			return { uuid: texture.uuid, painted: { x: x, y: y, w: w, h: h } };
		},

		paint_pixels(p) {
			requireProject();
			let texture = resolveTexture(p.texture);
			if (!texture) throw new Error('No texture. Create one first.');
			if (!p.pixels || !p.pixels.length) throw new Error('paint_pixels requires "pixels".');
			// Validate/convert ALL colors BEFORE opening the texture edit so a bad
			// color can't throw mid-edit (which would leave Undo dangling + view stale).
			let prepared = p.pixels.map(px => ({ x: px.x | 0, y: px.y | 0, rgba: toRgba(px.color) }));
			texture.edit(() => {
				let ctx = Painter.current.ctx;
				let off = Painter.current.offset || [0, 0];
				for (let px of prepared) {
					let id = new ImageData(1, 1);
					id.data.set([px.rgba.r, px.rgba.g, px.rgba.b, Math.round(px.rgba.a * 255)]);
					ctx.putImageData(id, px.x - off[0], px.y - off[1]);
				}
			}, { edit_name: 'Paint pixels (MCP)' });
			return { uuid: texture.uuid, count: prepared.length };
		},

		get_texture(p) {
			requireProject();
			let texture = resolveTexture(p.texture);
			if (!texture) throw new Error('No texture available.');
			if (texture.layers_enabled && typeof texture.updateLayerChanges === 'function') {
				try { texture.updateLayerChanges(true); } catch (e) {}
			}
			return { uuid: texture.uuid, name: texture.name, width: texture.width, height: texture.height, data_url: texture.getDataURL() };
		},

		apply_texture(p) {
			requireProject();
			let texture = resolveTexture(p.texture);
			if (!texture) throw new Error('Texture not found: ' + p.texture);
			let cubes;
			if (!p.target || p.target === 'all') cubes = Cube.all;
			else {
				let el = resolveElement(p.target);
				if (!el) throw new Error('Element not found: ' + p.target);
				cubes = [el];
			}
			return withUndo({ elements: cubes, uv_only: true }, 'Apply texture (MCP)', () => {
				for (let cube of cubes) {
					if (typeof cube.applyTexture === 'function') {
						cube.applyTexture(texture, true);
					} else if (cube.faces) {
						for (let f in cube.faces) cube.faces[f].texture = texture.uuid;
						if (cube.preview_controller) {
							cube.preview_controller.updateFaces(cube);
							cube.preview_controller.updateUV(cube);
						}
					}
				}
				return { texture: texture.uuid, applied_to: cubes.length };
			});
		},

		// ---------- UV ----------
		set_face_uv(p) {
			requireProject();
			let cube = resolveElement(p.target);
			if (!cube || !cube.faces) throw new Error('Cube not found: ' + p.target);
			let face = cube.faces[p.face];
			if (!face) throw new Error('Invalid face "' + p.face + '". Use north/east/south/west/up/down.');
			return withUndo({ elements: [cube], uv_only: true }, 'Set face UV (MCP)', () => {
				cube.autouv = 0;
				face.uv = [Number(p.uv[0]), Number(p.uv[1]), Number(p.uv[2]), Number(p.uv[3])];
				if (typeof p.rotation === 'number') face.rotation = p.rotation;
				if (p.texture) face.texture = resolveTexture(p.texture).uuid;
				cube.preview_controller.updateUV(cube);
				if (p.texture) cube.preview_controller.updateFaces(cube);
				return { uuid: cube.uuid, face: p.face, uv: face.uv.slice() };
			});
		},

		auto_uv(p) {
			requireProject();
			let cubes;
			if (!p.target || p.target === 'all') cubes = Cube.all;
			else {
				let el = resolveElement(p.target);
				if (!el) throw new Error('Element not found: ' + p.target);
				cubes = [el];
			}
			return withUndo({ elements: cubes }, 'Auto UV (MCP)', () => {
				for (let cube of cubes) {
					if (cube.box_uv) continue;
					cube.autouv = 1;
					if (typeof cube.mapAutoUV === 'function') cube.mapAutoUV();
				}
				return { count: cubes.length };
			});
		},

		get_uv(p) {
			requireProject();
			let cube = resolveElement(p.target);
			if (!cube || !cube.faces) throw new Error('Cube not found: ' + p.target);
			let result = {
				uuid: cube.uuid, box_uv: cube.box_uv,
				uv_offset: cube.uv_offset ? cube.uv_offset.slice() : undefined,
				mirror_uv: cube.mirror_uv, autouv: cube.autouv,
				resolution: [Project.texture_width, Project.texture_height], faces: {},
			};
			for (let fkey in cube.faces) {
				let face = cube.faces[fkey];
				let tex = (typeof face.getTexture === 'function') ? face.getTexture() : null;
				result.faces[fkey] = {
					uv: face.uv ? face.uv.slice() : null, rotation: face.rotation,
					texture: face.texture, texture_name: tex ? tex.name : null, enabled: face.enabled,
				};
			}
			return result;
		},

		// ---------- animation ----------
		create_animation(p) {
			requireProject();
			ensureAnimationFormat();
			ensureAnimateMode();
			let name = p.name || 'animation';
			// Bedrock requires namespaced ids like "animation.<geo>.<name>".
			if (String(Format.id).includes('bedrock') && !name.startsWith('animation.')) {
				name = 'animation.' + (Project.geometry_name || Project.name || 'model') + '.' + name;
			}
			let animation = new Animation({
				name: name, loop: p.loop || 'loop',
				length: typeof p.length === 'number' ? p.length : 1.0,
				snapping: p.snapping || 24,
			}).add(true); // .add(true) selects it and wraps Undo
			return { uuid: animation.uuid, name: animation.name };
		},

		list_animations() {
			requireProject();
			if (typeof Animation === 'undefined') return [];
			return Animation.all.map(animation => {
				let bones = {};
				for (let uuid in animation.animators) {
					let an = animation.animators[uuid];
					let channels = {};
					for (let channel in an.channels) {
						let kfs = (an[channel] || []).slice().sort((a, b) => a.time - b.time).map(kf => ({
							uuid: kf.uuid, time: kf.time, interpolation: kf.interpolation,
							values: kf.transform ? kf.getArray() : kf.data_points.map(dp => dp.effect || dp.script),
						}));
						if (kfs.length) channels[channel] = kfs;
					}
					bones[uuid] = { name: an.name, type: an.type, channels: channels };
				}
				return {
					uuid: animation.uuid, name: animation.name, loop: animation.loop,
					length: animation.length, snapping: animation.snapping,
					selected: animation === Animation.selected, bones: bones,
				};
			});
		},

		select_animation(p) {
			requireProject();
			ensureAnimationFormat();
			ensureAnimateMode();
			let animation = resolveAnimation(p.animation);
			if (!animation) throw new Error('Animation not found.');
			animation.select();
			return { uuid: animation.uuid, name: animation.name };
		},

		add_keyframe(p) {
			requireProject();
			ensureAnimationFormat();
			ensureAnimateMode();
			let animation = resolveAnimation(p.animation);
			if (!animation) throw new Error('No animation. Create one with create_animation first.');
			animation.select();
			let bone = resolveGroup(p.bone);
			if (!bone) throw new Error('Bone (group) not found: ' + p.bone);
			let ba = animation.getBoneAnimator(bone);
			if (!ba) throw new Error('Could not get a bone animator for that group (scope mismatch?).');
			if (!ba.channels || !ba.channels[p.channel]) throw new Error('Invalid channel "' + p.channel + '". Use rotation/position/scale.');
			const VALID_INTERP = ['linear', 'catmullrom', 'bezier', 'step'];
			if (p.interpolation && !VALID_INTERP.includes(p.interpolation)) throw new Error('Invalid interpolation "' + p.interpolation + '".');

			let value = p.value;
			if (Array.isArray(value)) value = { x: value[0], y: value[1], z: value[2] };

			return withUndo({ keyframes: [] }, 'Add keyframe (MCP)', (finish) => {
				let kf = ba.createKeyframe(value, Number(p.time) || 0, p.channel, false, false);
				if (!kf) throw new Error('Keyframe was not created.');
				if (p.interpolation) kf.interpolation = p.interpolation;
				finish({ keyframes: [kf] });
				if (typeof Animator !== 'undefined') Animator.preview();
				return { uuid: kf.uuid, time: kf.time, channel: p.channel, bone: bone.uuid };
			});
		},

		set_timeline_time(p) {
			requireProject();
			ensureAnimationFormat();
			ensureAnimateMode();
			if (p.animation) {
				let animation = resolveAnimation(p.animation);
				if (animation) animation.select();
			}
			if (typeof Timeline !== 'undefined') Timeline.setTime(Number(p.time) || 0);
			if (typeof Animator !== 'undefined') Animator.preview();
			return { time: (typeof Timeline !== 'undefined') ? Timeline.time : p.time };
		},

		// ---------- render ----------
		render_view(p) {
			requireProject();
			let W = Math.max(16, Math.min(2048, parseInt(p.width, 10) || 600));
			let H = Math.max(16, Math.min(2048, parseInt(p.height, 10) || 600));
			let angle = p.angle || 'isometric_right';

			let live = (typeof Preview !== 'undefined' && Preview.selected) ? Preview.selected
				: (typeof main_preview !== 'undefined' ? main_preview : null);
			let view = (typeof MediaPreview !== 'undefined' && MediaPreview) ? MediaPreview : null;
			if (!view) throw new Error('Offscreen renderer (MediaPreview) is unavailable.');

			Canvas.updateAll();

			if (angle === 'view' && live && typeof view.copyView === 'function') {
				view.copyView(live);
				if (p.projection) view.setProjectionMode(p.projection === 'orthographic', true);
			} else {
				let preset = DefaultCameraPresets.find(x => x.id === angle) || DefaultCameraPresets.find(x => x.id === 'isometric_right');
				view.loadAnglePreset(preset);
				// Frame in perspective for a reliable fit, then convert to ortho if needed.
				view.setProjectionMode(false);
				if (typeof view.setFOV === 'function') view.setFOV(30);
				let mb = modelBounds(); // whole model, independent of current selection
				view.controls.target.fromArray(mb.center);
				if (typeof scene !== 'undefined' && scene.position) view.controls.target.add(scene.position);
				let radius = Math.max(mb.size[0], mb.size[1], mb.size[2], 4);
				let dir = view.camPers.position.clone().sub(view.controls.target);
				if (dir.lengthSq() < 1e-6) dir.set(1, 0.8, 1);
				dir.normalize();
				let dist = radius * 1.7 + 10;
				view.camPers.position.copy(view.controls.target).add(dir.multiplyScalar(dist));
				let wantOrtho = (p.projection === 'orthographic') || (!p.projection && preset && preset.projection === 'orthographic');
				if (wantOrtho) view.setProjectionMode(true, true);
				view.controls.update();
			}

			// resize LAST so the renderer/camera frustum is sized for the final projection.
			view.resize(W, H);

			let render = () => { view.render(); };
			if (p.gizmos) render(); else Canvas.withoutGizmos(render);

			let dataUrl;
			if (p.background) {
				let rgba = toRgba(p.background);
				let frameCanvas, fctx;
				if (typeof CanvasFrame !== 'undefined') {
					let frame = new CanvasFrame(view.canvas.width, view.canvas.height);
					frameCanvas = frame.canvas; fctx = frame.ctx;
				} else {
					frameCanvas = document.createElement('canvas');
					frameCanvas.width = view.canvas.width; frameCanvas.height = view.canvas.height;
					fctx = frameCanvas.getContext('2d');
				}
				fctx.fillStyle = rgbaCss(rgba);
				fctx.fillRect(0, 0, frameCanvas.width, frameCanvas.height);
				fctx.drawImage(view.canvas, 0, 0);
				dataUrl = frameCanvas.toDataURL('image/png');
			} else {
				dataUrl = view.canvas.toDataURL('image/png');
			}
			return { data_url: dataUrl, width: view.canvas.width, height: view.canvas.height, angle: angle };
		},

		// ---------- universal action bridge (exposes EVERY Blockbench command) ----------
		list_actions(p) {
			let q = p && p.query ? String(p.query).toLowerCase() : null;
			let out = [];
			for (let id in BarItems) {
				let item = BarItems[id];
				if (!item) continue;
				if (p && p.category && item.category !== p.category) continue;
				let available = true;
				try { available = (typeof item.conditionMet === 'function') ? item.conditionMet() : true; } catch (e) {}
				if (p && p.only_available && !available) continue;
				if (q) {
					let hay = (id + ' ' + (item.name || '') + ' ' + (item.description || '')).toLowerCase();
					if (!hay.includes(q)) continue;
				}
				let entry = {
					id: id, name: item.name, description: item.description || '',
					type: item.type, category: item.category, available: available,
					keybind: item.keybind ? String(item.keybind) : undefined,
				};
				if (item.type === 'toggle') entry.value = item.value;
				if (item.type === 'select') { entry.value = item.value; entry.options = item.values ? item.values.slice() : (item.options ? Object.keys(item.options) : undefined); }
				if (typeof item.value === 'number') entry.value = item.value;
				out.push(entry);
			}
			out.sort((a, b) => a.id < b.id ? -1 : 1);
			return { count: out.length, actions: out };
		},

		get_action(p) {
			if (!p.id) throw new Error('get_action requires "id".');
			let item = BarItems[p.id];
			if (!item) throw new Error('Unknown action: ' + p.id);
			let available = true;
			try { available = (typeof item.conditionMet === 'function') ? item.conditionMet() : true; } catch (e) {}
			let entry = {
				id: item.id, name: item.name, description: item.description || '',
				type: item.type, category: item.category, available: available,
				keybind: item.keybind ? String(item.keybind) : undefined,
			};
			if (item.type === 'toggle') entry.value = item.value;
			if (item.type === 'select') { entry.value = item.value; entry.options = item.values ? item.values.slice() : (item.options ? Object.keys(item.options) : undefined); }
			if (typeof item.value === 'number') entry.value = item.value;
			return entry;
		},

		run_action(p) {
			if (!p.id) throw new Error('run_action requires "id".');
			let item = BarItems[p.id];
			if (!item) throw new Error('Unknown action: ' + p.id + '. Use list_actions to discover ids.');
			let type = item.type;
			if (type === 'toggle') {
				if (typeof p.value === 'boolean') item.set(p.value);
				else if (typeof item.trigger === 'function') item.trigger();
				return { id: p.id, type: type, value: item.value };
			}
			if (type === 'select') {
				if (p.value !== undefined) {
					item.set(String(p.value));
					if (typeof item.onChange === 'function') item.onChange(item);
				} else if (typeof item.trigger === 'function') {
					item.trigger();
				}
				return { id: p.id, type: type, value: item.value };
			}
			if (typeof p.value === 'number' && (typeof item.change === 'function' || typeof item.set === 'function')) {
				if (typeof item.change === 'function') item.change(() => p.value);
				else item.set(p.value);
				return { id: p.id, type: type, value: item.value };
			}
			if (typeof item.trigger === 'function') {
				let ran = item.trigger();
				return { id: p.id, type: type, triggered: ran !== false };
			}
			if (typeof item.click === 'function') { item.click(); return { id: p.id, type: type, clicked: true }; }
			throw new Error('Action "' + p.id + '" cannot be run programmatically.');
		},

		// ---------- selection / modes / settings ----------
		select(p) {
			requireProject();
			if (p.elements !== undefined) {
				if (typeof unselectAllElements === 'function') unselectAllElements();
				if (p.elements === 'all') {
					Outliner.elements.forEach(e => e.markAsSelected());
				} else if (Array.isArray(p.elements)) {
					for (let ref of p.elements) { let el = resolveElement(ref); if (el) el.markAsSelected(); }
				} // 'none' or [] => leave cleared
				if (typeof updateSelection === 'function') updateSelection();
			}
			if (p.group) {
				let g = resolveGroup(p.group);
				if (g && typeof g.select === 'function') g.select();
			}
			if (p.texture) {
				let t = resolveTexture(p.texture);
				if (t && typeof t.select === 'function') t.select();
			}
			if (typeof updateSelection === 'function') updateSelection();
			return {
				selected_elements: Outliner.selected.map(e => ({ uuid: e.uuid, name: e.name, type: e.type })),
				selected_group: (Group.first_selected) ? Group.first_selected.uuid : null,
				selected_texture: (Texture.selected) ? Texture.selected.uuid : null,
			};
		},

		list_modes() {
			let out = [];
			for (let id in Modes.options) {
				let m = Modes.options[id];
				let available = true;
				try { available = (typeof m.conditionMet === 'function') ? m.conditionMet() : (typeof Condition === 'function' ? Condition(m.condition) : true); } catch (e) {}
				out.push({ id: id, name: m.name, available: available });
			}
			return { selected: (Modes.selected) ? Modes.selected.id : null, modes: out };
		},

		set_mode(p) {
			let m = Modes.options[p.mode];
			if (!m) throw new Error('Unknown mode "' + p.mode + '". Available: ' + Object.keys(Modes.options).join(', '));
			m.select();
			return { mode: (Modes.selected) ? Modes.selected.id : null };
		},

		list_settings(p) {
			return Object.values(settings)
				.filter(s => !p || !p.category || s.category === p.category)
				.map(s => {
					let o = { id: s.id, name: s.name, type: s.type, category: s.category, value: s.value };
					if (s.type === 'select' && s.options) o.options = Object.keys(s.options);
					return o;
				});
		},

		get_setting(p) {
			let s = settings[p.id];
			if (!s) throw new Error('Unknown setting: ' + p.id);
			let o = { id: s.id, name: s.name, type: s.type, category: s.category, value: s.value };
			if (s.type === 'select' && s.options) o.options = Object.keys(s.options);
			return o;
		},

		set_setting(p) {
			let s = settings[p.id];
			if (!s) throw new Error('Unknown setting: ' + p.id + '. Use list_settings to discover ids.');
			if (typeof s.set === 'function') {
				s.set(p.value);
			} else {
				s.value = p.value;
				if (typeof s.onChange === 'function') s.onChange(s.value);
				if (typeof Settings !== 'undefined' && Settings.saveLocalStorages) Settings.saveLocalStorages();
			}
			return { id: s.id, value: s.value };
		},

		// ---------- power tool ----------
		async execute_script(p) {
			if (typeof p.code !== 'string') throw new Error('execute_script requires "code" (a string).');
			let fn = new Function('params', '"use strict"; return (async () => {\n' + p.code + '\n})();');
			let result = await fn(p.params || {});
			return { result: serializeSafe(result) };
		},
	};

	// ======================================================================
	//  TCP server
	// ======================================================================

	function handleAuth(socket, line) {
		let msg;
		try { msg = JSON.parse(line); } catch (e) { socket.destroy(); return false; }
		if (!msg || msg.type !== 'auth') {
			try { socket.write(JSON.stringify({ type: 'auth_err', message: 'Expected auth handshake.' }) + '\n'); } catch (e) {}
			socket.destroy(); return false;
		}
		if (msg.token && msg.token === getToken()) {
			socket._authed = true;
			try { socket.write(JSON.stringify({ type: 'auth_ok', protocol: PROTOCOL }) + '\n'); } catch (e) {}
			return true;
		}
		try {
			socket.write(JSON.stringify({ type: 'auth_err', message: 'Invalid or missing token. In Blockbench run "MCP Bridge: Status" to copy the token and set BLOCKBENCH_MCP_TOKEN for the MCP server.' }) + '\n');
		} catch (e) {}
		socket.destroy(); return false;
	}

	function handleLine(socket, line) {
		let msg;
		try { msg = JSON.parse(line); } catch (e) { return; }
		if (!msg || msg.type !== 'req') return;

		function respond(ok, payload) {
			let res = ok ? { type: 'res', id: msg.id, ok: true, result: payload }
				: { type: 'res', id: msg.id, ok: false, error: payload };
			try { socket.write(JSON.stringify(res) + '\n'); } catch (e) { log('write failed', e.message); }
		}

		let handler = handlers[msg.method];
		if (!handler) { respond(false, { message: 'Unknown method: ' + msg.method }); return; }

		Promise.resolve()
			.then(() => handler(msg.params || {}))
			.then(
				result => respond(true, result === undefined ? { ok: true } : result),
				err => respond(false, { message: (err && err.message) ? err.message : String(err), stack: err && err.stack })
			);
	}

	function startServer() {
		stopServer();
		let port = getPort();
		let sockets = window.__MCP_BRIDGE_SOCKETS__ = new Set();
		let server = net.createServer(socket => {
			sockets.add(socket);
			socket.setNoDelay(true);
			socket._authed = false;
			let decoder = new StringDecoder('utf8');
			let buffer = '';
			socket.on('data', chunk => {
				buffer += decoder.write(chunk);
				let idx;
				while ((idx = buffer.indexOf('\n')) >= 0) {
					let line = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 1);
					if (!line.trim()) continue;
					if (!socket._authed) {
						if (!handleAuth(socket, line)) return; // socket destroyed
						continue;
					}
					handleLine(socket, line);
				}
			});
			socket.on('close', () => sockets.delete(socket));
			socket.on('error', () => sockets.delete(socket));
			try { socket.write(JSON.stringify({ type: 'hello', app: 'blockbench', version: Blockbench.version, protocol: PROTOCOL }) + '\n'); } catch (e) {}
		});
		server.on('error', err => {
			if (err && err.code === 'EADDRINUSE') {
				Blockbench.showMessageBox({
					title: 'MCP Bridge',
					message: 'Port ' + port + ' is already in use. Another Blockbench window (or app) may be hosting the bridge.\n\nUse "MCP Bridge: Set Port" to choose a different port, then restart the server.',
				});
			} else {
				log('server error', err && err.message);
			}
		});
		server.listen(port, '127.0.0.1', () => {
			log('listening on 127.0.0.1:' + port);
			Blockbench.showQuickMessage('MCP Bridge listening on port ' + port, 2500);
		});
		window.__MCP_BRIDGE_SERVER__ = server;
	}

	function stopServer() {
		let sockets = window.__MCP_BRIDGE_SOCKETS__;
		if (sockets) {
			for (let s of sockets) { try { s.destroy(); } catch (e) {} }
			sockets.clear();
		}
		let server = window.__MCP_BRIDGE_SERVER__;
		if (server) {
			try { server.close(); } catch (e) {}
			window.__MCP_BRIDGE_SERVER__ = null;
			log('server stopped');
		}
	}

	// ======================================================================
	//  Plugin lifecycle
	// ======================================================================

	function addManagementActions() {
		// NOTE: actions are created directly (NOT via BARS.defineActions, whose queue
		// is drained only once at boot — long before a sideloaded plugin's onload).
		let restart = new Action('mcp_bridge_restart', {
			name: 'MCP Bridge: Restart Server', description: 'Restart the MCP bridge TCP server',
			icon: 'restart_alt', category: 'edit', click() { startServer(); },
		});
		let setPort = new Action('mcp_bridge_set_port', {
			name: 'MCP Bridge: Set Port', description: 'Change the TCP port the MCP bridge listens on',
			icon: 'settings_ethernet', category: 'edit',
			click() {
				Blockbench.textPrompt('MCP Bridge Port', String(getPort()), value => {
					let port = parseInt(value, 10);
					if (Number.isFinite(port) && port > 0 && port < 65536) {
						localStorage.setItem('mcp_bridge_port', String(port));
						startServer();
					} else {
						Blockbench.showQuickMessage('Invalid port', 1500);
					}
				});
			},
		});
		let status = new Action('mcp_bridge_status', {
			name: 'MCP Bridge: Status', description: 'Show MCP bridge status, port, and auth token',
			icon: 'sensors', category: 'edit',
			click() {
				let running = !!window.__MCP_BRIDGE_SERVER__;
				Blockbench.showMessageBox({
					title: 'MCP Bridge',
					message: 'Status: ' + (running ? 'running' : 'stopped') +
						'\nHost: 127.0.0.1\nPort: ' + getPort() +
						'\n\nAuth token (set as BLOCKBENCH_MCP_TOKEN for the MCP server):\n' + getToken() +
						'\n\nKeep this token secret — it grants full control of Blockbench.',
				});
			},
		});
		actions = [restart, setPort, status];
		if (typeof MenuBar !== 'undefined' && MenuBar.addAction) {
			actions.forEach(a => { try { MenuBar.addAction(a, 'tools'); } catch (e) {} });
		}
	}

	Plugin.register(PLUGIN_ID, {
		title: 'MCP Bridge',
		author: 'Blockbench MCP',
		description: 'Lets an external MCP server (and AI assistant) control Blockbench: model, texture, animate, and render.',
		icon: 'cable',
		version: '0.1.0',
		variant: 'desktop',
		tags: ['Automation', 'Developer'],
		onload() {
			try {
				net = require('net', {
					optional: false,
					message: 'The MCP Bridge needs a local TCP socket (127.0.0.1 only) so an MCP server (your AI assistant) can control Blockbench. Nothing is exposed to the internet.',
				});
				let sd = require('string_decoder');
				StringDecoder = sd.StringDecoder;
			} catch (e) {
				log('require failed', e.message);
			}
			if (!net || !StringDecoder) {
				Blockbench.showMessageBox({
					title: 'MCP Bridge',
					message: 'The MCP Bridge could not get network access (the "net" module was denied). The bridge is disabled. Re-enable the plugin and grant permission to use it.',
				});
				return;
			}

			getToken(); // ensure a token exists
			addManagementActions();
			startServer();
			log('ready. Token (set BLOCKBENCH_MCP_TOKEN): ' + getToken());
		},
		onunload() {
			stopServer();
			actions.forEach(a => { try { a.delete(); } catch (e) {} });
			actions = [];
		},
	});
})();
