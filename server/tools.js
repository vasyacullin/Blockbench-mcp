// tools.js
// MCP tool definitions. Each tool is a thin, well-described wrapper that forwards
// to a method on the Blockbench bridge (see bridge-client.js) and formats the
// result for the LLM. The method names + param shapes here are the CONTRACT that
// the Blockbench plugin (plugin/blockbench_mcp_bridge.js) implements.

import { z } from 'zod';

// ---- shared helpers ---------------------------------------------------------

const vec3 = z.array(z.number()).length(3);
const vec2 = z.array(z.number()).length(2);
const color = z
  .string()
  .describe('Color as a CSS/hex string, e.g. "#ff0000", "#ff0000aa", or "rgba(255,0,0,1)".');

/** A reference to an element/group/texture/animation: its uuid OR its (unique-ish) name. */
const ref = z.string().describe('uuid or name of the target object');

function textResult(result) {
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: 'text', text: text || '(no result)' }] };
}

function errorResult(err) {
  let text = 'Error: ' + (err?.message || String(err));
  if (err?.bridgeStack) text += '\n\nBlockbench stack:\n' + err.bridgeStack;
  return { content: [{ type: 'text', text }], isError: true };
}

/** Split a "data:image/png;base64,XXXX" URL into {mimeType, data}. */
function splitDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '');
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

// ---- tool table -------------------------------------------------------------
// Most tools just forward their validated args straight through as params.
// `method` is the bridge method; `schema` is the Zod raw shape.

const TOOLS = [
  // ---------- meta ----------
  {
    name: 'bb_status',
    method: 'status',
    title: 'Blockbench status',
    description:
      'Check whether Blockbench is connected via the bridge and summarize the current project (format, open tab, element/texture/animation counts, current mode). Call this first if anything seems off.',
    readOnly: true,
    schema: {},
  },

  // ---------- project ----------
  {
    name: 'bb_list_formats',
    method: 'list_formats',
    title: 'List model formats',
    description:
      'List all model formats Blockbench supports (id, name, category, animation/bone support). Use a format id with bb_create_project. Common ids: free, java_block, bedrock, bedrock_block, skin, modded_entity, optifine_entity.',
    readOnly: true,
    schema: {},
  },
  {
    name: 'bb_create_project',
    method: 'create_project',
    title: 'Create project',
    description:
      'Create a NEW empty project (a new tab) of the given format. This is required before adding cubes/textures/animations if no project is open. Returns the project uuid.',
    schema: {
      format: z.string().describe('Format id, e.g. "bedrock", "java_block", "free". See bb_list_formats.'),
      name: z.string().optional().describe('Project / model name'),
      texture_width: z.number().int().positive().optional().describe('Default UV/texture width (px), e.g. 16, 32, 64'),
      texture_height: z.number().int().positive().optional().describe('Default UV/texture height (px)'),
    },
  },
  {
    name: 'bb_get_project',
    method: 'get_project',
    title: 'Get project info',
    description: 'Get detailed info about the currently open project: name, format, UV size, and counts of elements/groups/textures/animations.',
    readOnly: true,
    schema: {},
  },
  {
    name: 'bb_save_project',
    method: 'save_project',
    title: 'Save .bbmodel project',
    description:
      'Save the current project as a Blockbench .bbmodel file to an absolute path on disk. Creates/overwrites the file. Use bb_export_model for game-native formats (Java/Bedrock JSON, glTF, OBJ, etc.).',
    schema: {
      path: z.string().describe('Absolute file path ending in .bbmodel, e.g. "C:/models/mob.bbmodel"'),
    },
  },
  {
    name: 'bb_export_model',
    method: 'export_model',
    title: 'Export model (native format)',
    description:
      "Export the current project in its native game format (or a specific codec). If `path` is given, writes to disk; otherwise returns the file content as text. Codec defaults to the format's native codec (e.g. java_block, bedrock). Other codecs: gltf, obj, collada, stl.",
    schema: {
      path: z.string().optional().describe('Absolute output path. If omitted, the content is returned as text.'),
      codec: z.string().optional().describe('Codec id override, e.g. "java_block", "bedrock", "gltf", "obj".'),
    },
  },
  {
    name: 'bb_load_project',
    method: 'load_project',
    title: 'Open / load a model',
    description:
      'Open a model into a new tab, either from an absolute file path or from raw file content (e.g. a .bbmodel JSON string). Auto-detects the format.',
    schema: {
      path: z.string().optional().describe('Absolute path to a model file (.bbmodel, .json, .gltf, ...)'),
      content: z.string().optional().describe('Raw file content (used if path is not given). Provide a filename via `name` so the format can be detected.'),
      name: z.string().optional().describe('Filename (with extension) used to detect the codec when loading from content.'),
    },
  },

  // ---------- geometry ----------
  {
    name: 'bb_add_cube',
    method: 'add_cube',
    title: 'Add cube',
    description:
      'Create a box (cube) element. Coordinates are in Blockbench model units. `from` is the min corner, `to` the max corner. Optionally nest under a group/bone and assign a texture. Returns the cube uuid.',
    schema: {
      name: z.string().optional(),
      from: vec3.describe('Min corner [x,y,z]'),
      to: vec3.describe('Max corner [x,y,z] (must be >= from on each axis)'),
      origin: vec3.optional().describe('Pivot point [x,y,z] (for rotation). Defaults to [0,0,0].'),
      rotation: vec3.optional().describe('Rotation in degrees [x,y,z]. Note: most MC formats only allow rotation on a single axis at a limited angle.'),
      uv_offset: vec2.optional().describe('Box-UV offset [u,v] (box-uv formats only)'),
      inflate: z.number().optional().describe('Inflate/expand the box by N units on all sides'),
      group: ref.optional().describe('Parent group/bone (uuid or name) to nest this cube under'),
      texture: ref.optional().describe('Texture (uuid or name) to apply to all faces'),
      autouv: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional().describe('0=manual UV, 1=auto, 2=relative auto'),
    },
  },
  {
    name: 'bb_add_group',
    method: 'add_group',
    title: 'Add group / bone',
    description:
      'Create a group (a.k.a. bone in rigged formats). Groups organize elements and act as pivots for animation. Returns the group uuid.',
    schema: {
      name: z.string().optional(),
      origin: vec3.optional().describe('Bone pivot point [x,y,z]'),
      rotation: vec3.optional().describe('Rotation in degrees [x,y,z]'),
      parent: ref.optional().describe('Parent group (uuid or name), or omit for top level'),
    },
  },
  {
    name: 'bb_add_mesh',
    method: 'add_mesh',
    title: 'Add mesh (free-form polygons)',
    description:
      'Create a free-form polygon mesh from explicit vertices and faces (only in formats that support meshes, e.g. bedrock, free). Faces reference vertices by their INDEX in the `vertices` array. 3 indices = triangle, 4 = quad. Winding order sets the normal.',
    schema: {
      name: z.string().optional(),
      vertices: z.array(vec3).min(3).describe('List of vertex positions [[x,y,z],...]'),
      faces: z
        .array(
          z.object({
            vertices: z.array(z.number().int()).min(3).max(4).describe('Indices into the vertices array (3=tri, 4=quad)'),
            uv: z.array(vec2).optional().describe('Optional UV per face vertex [[u,v],...], same order as vertices'),
          })
        )
        .min(1)
        .describe('Faces, each referencing vertices by index'),
      origin: vec3.optional(),
      rotation: vec3.optional(),
      group: ref.optional().describe('Parent group/bone (uuid or name)'),
      texture: ref.optional().describe('Texture (uuid or name) to apply to all faces'),
    },
  },
  {
    name: 'bb_edit_element',
    method: 'edit_element',
    title: 'Edit element',
    description:
      'Modify an existing cube/element: set its geometry (from/to), pivot (origin), rotation, name, or visibility. Only the provided fields change. Use bb_list_elements to find uuids/names.',
    schema: {
      target: ref,
      from: vec3.optional(),
      to: vec3.optional(),
      origin: vec3.optional(),
      rotation: vec3.optional().describe('Rotation in degrees [x,y,z]'),
      inflate: z.number().optional(),
      rename: z.string().optional().describe('New name'),
      visibility: z.boolean().optional(),
    },
  },
  {
    name: 'bb_delete_element',
    method: 'delete_element',
    title: 'Delete element / group',
    description: 'Delete an element or group (and, for groups, all of its children). Undoable in Blockbench.',
    schema: { target: ref },
  },
  {
    name: 'bb_duplicate_element',
    method: 'duplicate_element',
    title: 'Duplicate element',
    description: 'Duplicate an element (or group + children). Returns the new uuid.',
    schema: { target: ref },
  },
  {
    name: 'bb_set_parent',
    method: 'set_parent',
    title: 'Reparent element/group',
    description: 'Move an element or group under a different parent group (or to "root" for top level).',
    schema: {
      target: ref,
      parent: z.string().describe('Parent group uuid/name, or "root" for top level'),
      index: z.number().int().optional().describe('Insertion index within the parent (default: append)'),
    },
  },
  {
    name: 'bb_list_elements',
    method: 'list_elements',
    title: 'List elements & groups',
    description:
      'List every element (cubes, meshes, locators...) and group in the project with their uuids, names, parents, and geometry. Use this to discover what to edit.',
    readOnly: true,
    schema: {},
  },

  // ---------- textures / painting ----------
  {
    name: 'bb_create_texture',
    method: 'create_texture',
    title: 'Create blank texture',
    description:
      'Create a new blank texture (optionally filled with a color) and add it to the project. Returns its uuid. Use bb_paint_rect / bb_paint_pixels / bb_fill_texture to draw on it.',
    schema: {
      name: z.string().optional(),
      width: z.number().int().positive().optional().describe('Width in px (default = project texture_width or 16)'),
      height: z.number().int().positive().optional().describe('Height in px (default = project texture_height or 16)'),
      fill: color.optional().describe('Fill color. Omit for fully transparent.'),
      folder: z.string().optional().describe('Texture folder/category (e.g. "block")'),
    },
  },
  {
    name: 'bb_list_textures',
    method: 'list_textures',
    title: 'List textures',
    description: 'List all textures in the project (uuid, name, size, which is selected).',
    readOnly: true,
    schema: {},
  },
  {
    name: 'bb_import_texture',
    method: 'import_texture',
    title: 'Import texture from image data',
    description:
      'Add a texture from PNG image data (a data URL or raw base64 PNG). Useful for supplying a pre-made image. Returns its uuid.',
    schema: {
      name: z.string().optional(),
      data_url: z.string().optional().describe('A "data:image/png;base64,..." URL'),
      base64: z.string().optional().describe('Raw base64 PNG (without the data: prefix). Used if data_url is absent.'),
      folder: z.string().optional(),
    },
  },
  {
    name: 'bb_fill_texture',
    method: 'fill_texture',
    title: 'Fill entire texture',
    description: 'Fill the whole texture with a solid color (overwrites all pixels).',
    schema: {
      texture: ref.optional().describe('Texture uuid/name (default: selected/active texture)'),
      color: color,
    },
  },
  {
    name: 'bb_paint_rect',
    method: 'paint_rect',
    title: 'Paint rectangle',
    description:
      'Paint a filled rectangle of pixels on a texture. Coordinates are in texture pixels, origin top-left. By default blends by alpha (source-over); set blend:"replace" to overwrite exact RGBA.',
    schema: {
      texture: ref.optional().describe('Texture uuid/name (default: selected/active texture)'),
      x: z.number().int(),
      y: z.number().int(),
      w: z.number().int().positive(),
      h: z.number().int().positive(),
      color: color,
      blend: z.enum(['source-over', 'replace']).optional().describe('"source-over" (default, alpha blend) or "replace" (exact overwrite incl. clearing to transparent)'),
    },
  },
  {
    name: 'bb_paint_pixels',
    method: 'paint_pixels',
    title: 'Paint individual pixels',
    description:
      'Set individual pixels on a texture, each with an exact RGBA color (overwrite). Efficient for precise pixel art / sprites. Coordinates origin top-left.',
    schema: {
      texture: ref.optional().describe('Texture uuid/name (default: selected/active texture)'),
      pixels: z
        .array(
          z.object({
            x: z.number().int(),
            y: z.number().int(),
            color: color,
          })
        )
        .min(1)
        .describe('Pixels to set: [{x,y,color}, ...]'),
    },
  },
  {
    name: 'bb_get_texture',
    method: 'get_texture',
    title: 'View a texture',
    description: 'Return a texture as an image so you can SEE its current pixels. Defaults to the selected texture.',
    readOnly: true,
    image: true,
    schema: {
      texture: ref.optional().describe('Texture uuid/name (default: selected/active texture)'),
    },
  },
  {
    name: 'bb_apply_texture',
    method: 'apply_texture',
    title: 'Apply texture to faces',
    description: 'Assign a texture to all faces of a cube (or to all cubes if target omitted/"all").',
    schema: {
      texture: ref.describe('Texture uuid/name to apply'),
      target: ref.optional().describe('Cube uuid/name, or "all" for every cube (default: all)'),
    },
  },

  // ---------- UV ----------
  {
    name: 'bb_set_face_uv',
    method: 'set_face_uv',
    title: 'Set face UV',
    description:
      'Set explicit UV coordinates for one face of a cube. UV is [x1,y1,x2,y2] in texture pixels. Disables auto-UV for that cube so the values persist. (Per-face-UV formats; for box-uv formats edit uv_offset on the cube instead.)',
    schema: {
      target: ref.describe('Cube uuid/name'),
      face: z.enum(['north', 'east', 'south', 'west', 'up', 'down']),
      uv: z.array(z.number()).length(4).describe('[x1,y1,x2,y2] in texture pixels'),
      rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
      texture: ref.optional().describe('Texture uuid/name to assign to this face'),
    },
  },
  {
    name: 'bb_auto_uv',
    method: 'auto_uv',
    title: 'Auto-UV',
    description: 'Automatically lay out UVs for a cube (or all cubes) based on its dimensions.',
    schema: {
      target: ref.optional().describe('Cube uuid/name, or "all" (default: all cubes)'),
    },
  },
  {
    name: 'bb_get_uv',
    method: 'get_uv',
    title: 'Get UV layout',
    description: 'Read the current UV mapping of a cube (box-uv settings and/or per-face UVs).',
    readOnly: true,
    schema: { target: ref.describe('Cube uuid/name') },
  },

  // ---------- animation ----------
  {
    name: 'bb_create_animation',
    method: 'create_animation',
    title: 'Create animation',
    description:
      'Create a new animation and select it (enters Animate mode). Only works in formats with animation support (e.g. bedrock, modded_entity). Returns its uuid.',
    schema: {
      name: z.string().optional().describe('Animation name, e.g. "animation.mob.walk" for bedrock, or any name'),
      length: z.number().positive().optional().describe('Length in seconds (default 1.0)'),
      loop: z.enum(['once', 'loop', 'hold']).optional().describe('Loop mode (default "loop")'),
      snapping: z.number().int().positive().optional().describe('Keyframe snap fps (default 24)'),
    },
  },
  {
    name: 'bb_list_animations',
    method: 'list_animations',
    title: 'List animations',
    description: 'List all animations with their bones/channels/keyframes.',
    readOnly: true,
    schema: {},
  },
  {
    name: 'bb_select_animation',
    method: 'select_animation',
    title: 'Select animation',
    description: 'Make an animation the active one (for editing / preview).',
    schema: { animation: ref },
  },
  {
    name: 'bb_add_keyframe',
    method: 'add_keyframe',
    title: 'Add keyframe',
    description:
      'Add a keyframe to a bone on a channel (rotation in degrees, position in model units, scale as factors where 1=default) at a time in seconds. The bone must be a group. Values may be numbers or Molang strings.',
    schema: {
      bone: ref.describe('The bone/group (uuid or name)'),
      channel: z.enum(['rotation', 'position', 'scale']),
      time: z.number().min(0).describe('Time in seconds'),
      value: z
        .union([
          z.object({ x: z.union([z.number(), z.string()]).optional(), y: z.union([z.number(), z.string()]).optional(), z: z.union([z.number(), z.string()]).optional() }),
          z.array(z.union([z.number(), z.string()])).length(3),
        ])
        .describe('{x,y,z} or [x,y,z]. rotation=degrees, position=units, scale=factor (1=default).'),
      animation: ref.optional().describe('Animation uuid/name (default: selected animation)'),
      interpolation: z.enum(['linear', 'catmullrom', 'bezier', 'step']).optional(),
    },
  },
  {
    name: 'bb_set_timeline_time',
    method: 'set_timeline_time',
    title: 'Set timeline time (pose)',
    description: 'Move the animation timeline to a time (seconds) and apply the resulting pose to the model, so a render shows that frame.',
    schema: {
      time: z.number().min(0),
      animation: ref.optional().describe('Animation to preview (default: selected)'),
    },
  },

  // ---------- universal action bridge ----------
  {
    name: 'bb_list_actions',
    method: 'list_actions',
    title: 'List all Blockbench commands',
    description:
      'List every Blockbench command/tool/toggle/select (BarItem) — this exposes the ENTIRE menu/toolbar feature set, not just the dedicated tools. Each entry has an id, name, description, type, category, whether it is currently available, and (for toggles/selects/sliders) its current value/options. Filter with `query`/`category`. Run any of them with bb_run_action.',
    readOnly: true,
    schema: {
      query: z.string().optional().describe('Case-insensitive filter over id/name/description'),
      category: z.string().optional().describe('Filter by category (e.g. "edit", "transform", "file", "view", "animation")'),
      only_available: z.boolean().optional().describe('Only list commands whose condition is currently met'),
    },
  },
  {
    name: 'bb_get_action',
    method: 'get_action',
    title: 'Get a command',
    description: 'Get details about one Blockbench command (BarItem) by id: type, availability, current value, and (for selects) options.',
    readOnly: true,
    schema: { id: z.string() },
  },
  {
    name: 'bb_run_action',
    method: 'run_action',
    title: 'Run any Blockbench command',
    description:
      'Run ANY Blockbench command/tool/toggle/select by its id (discover ids with bb_list_actions). This is the universal bridge to the full feature set. For a toggle pass `value` (boolean) to set its state; for a select pass `value` (the option key); for a numeric slider pass `value` (number); for a plain action/tool omit `value`. Note: some commands open an interactive dialog — for those, prefer a dedicated tool or bb_execute_script.',
    schema: {
      id: z.string().describe('Command id, e.g. "undo", "redo", "add_cube", "selection_mode", "view_mode", "move_tool", "center_all", "export_over"'),
      value: z.union([z.string(), z.number(), z.boolean()]).optional().describe('Value for toggle (bool) / select (option key) / slider (number)'),
    },
  },

  // ---------- selection / modes / settings ----------
  {
    name: 'bb_select',
    method: 'select',
    title: 'Set selection',
    description:
      'Control what is selected, so selection-based commands/tools act on the right things. Set `elements` to "all", "none", or a list of uuids/names; optionally also select a `group` and/or a `texture`.',
    schema: {
      elements: z.union([z.literal('all'), z.literal('none'), z.array(ref)]).optional().describe('"all", "none", or a list of element uuids/names'),
      group: ref.optional().describe('Group/bone to select (uuid or name)'),
      texture: ref.optional().describe('Texture to make active (uuid or name)'),
    },
  },
  {
    name: 'bb_list_modes',
    method: 'list_modes',
    title: 'List editor modes',
    description: 'List editor modes (edit, paint, animate, display, …) and which is selected. Many features are only available in a specific mode.',
    readOnly: true,
    schema: {},
  },
  {
    name: 'bb_set_mode',
    method: 'set_mode',
    title: 'Switch editor mode',
    description: 'Switch the editor mode (e.g. "edit", "paint", "animate", "display"). Use bb_list_modes to see available ids.',
    schema: { mode: z.string() },
  },
  {
    name: 'bb_list_settings',
    method: 'list_settings',
    title: 'List settings',
    description: 'List Blockbench settings (id, name, type, category, current value, select options). Filter by `category`.',
    readOnly: true,
    schema: { category: z.string().optional() },
  },
  {
    name: 'bb_get_setting',
    method: 'get_setting',
    title: 'Get a setting',
    description: 'Read one Blockbench setting by id.',
    readOnly: true,
    schema: { id: z.string() },
  },
  {
    name: 'bb_set_setting',
    method: 'set_setting',
    title: 'Change a setting',
    description: 'Change a Blockbench setting by id (applies it immediately and persists).',
    schema: {
      id: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]).describe('New value (boolean for toggles, option key for selects, number for numeric, string for text)'),
    },
  },

  // ---------- power tool ----------
  {
    name: 'bb_execute_script',
    method: 'execute_script',
    title: 'Execute Blockbench script (advanced)',
    description:
      'Run arbitrary JavaScript inside Blockbench with full access to its API (Cube, Mesh, Group, Texture, Animation, Undo, Canvas, Project, Format, BarItems, Outliner, Painter, etc.). The code is the body of an async function: use `return` to send a JSON-serializable value back, and `await` for async ops. This is the escape hatch for anything the dedicated tools do not cover. Wrap model mutations in Undo.initEdit/finishEdit. Returns the returned value.',
    schema: {
      code: z.string().describe('JavaScript to run. e.g. `return Cube.all.map(c => c.name);`'),
    },
  },
];

// ---- registration -----------------------------------------------------------

export function registerAllTools(server, bridge) {
  for (const tool of TOOLS) {
    const annotations = { title: tool.title };
    if (tool.readOnly) {
      annotations.readOnlyHint = true;
      annotations.destructiveHint = false;
    }
    annotations.openWorldHint = false;

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
        annotations,
      },
      async (args) => {
        try {
          const result = await bridge.request(tool.method, args || {});

          // Tools that return an image (render / get_texture): emit an image block.
          if (tool.image || tool.name === 'bb_render_view') {
            const dataUrl = result?.data_url || result?.dataUrl;
            const split = splitDataUrl(dataUrl);
            if (split) {
              const meta = { ...result };
              delete meta.data_url;
              delete meta.dataUrl;
              return {
                content: [
                  { type: 'image', data: split.data, mimeType: split.mimeType },
                  { type: 'text', text: JSON.stringify(meta) },
                ],
              };
            }
          }
          return textResult(result);
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  // Render tool is special (image result + richer schema) — register separately.
  server.registerTool(
    'bb_render_view',
    {
      title: 'Render the model',
      description:
        'Render the current model to a PNG image so you can SEE it. Choose a camera angle, resolution, projection, and whether to show the grid/gizmos. Returns the image. Call this after making changes to verify the result.',
      inputSchema: {
        angle: z
          .enum(['view', 'initial', 'top', 'bottom', 'south', 'north', 'east', 'west', 'isometric_right', 'isometric_left'])
          .optional()
          .describe('Camera angle. "view" = current live camera. "south"=front, "north"=back. Default: isometric_right.'),
        width: z.number().int().positive().optional().describe('Output width px (default 600)'),
        height: z.number().int().positive().optional().describe('Output height px (default 600)'),
        projection: z.enum(['perspective', 'orthographic']).optional(),
        gizmos: z.boolean().optional().describe('Show grid/gizmos/outlines (default false = clean render)'),
        background: color.optional().describe('Solid background color. Omit for transparent.'),
      },
      annotations: { title: 'Render the model', readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await bridge.request('render_view', args || {});
        const split = splitDataUrl(result?.data_url);
        if (!split) return textResult(result);
        const meta = { width: result.width, height: result.height, angle: result.angle };
        return {
          content: [
            { type: 'image', data: split.data, mimeType: split.mimeType },
            { type: 'text', text: JSON.stringify(meta) },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

export { TOOLS };
