# Blockbench MCP

Let an LLM **model, texture, animate, and render** in [Blockbench](https://blockbench.net) through the [Model Context Protocol](https://modelcontextprotocol.io).

This is two pieces that talk to each other:

```
 ┌──────────────┐   stdio / MCP   ┌────────────────────┐   TCP / NDJSON   ┌─────────────────────────┐
 │  LLM client  │ ◄─────────────► │   MCP server       │ ◄──────────────► │  Blockbench (desktop)   │
 │ (Claude etc) │                 │  (mcp/server)      │   127.0.0.1      │  + "MCP Bridge" plugin  │
 └──────────────┘                 └────────────────────┘                  └─────────────────────────┘
```

- **`plugin/blockbench_mcp_bridge.js`** — a Blockbench plugin that runs *inside* the app and hosts a local TCP control server. It has full access to the live Blockbench API (`Cube`, `Texture`, `Animation`, `Undo`, `Canvas`, …).
- **`server/`** — a standalone Node MCP server. Your LLM client launches it over stdio; it connects to the plugin and exposes Blockbench's capabilities as MCP tools.

Why a TCP bridge instead of a normal MCP-in-process server? Blockbench's functionality lives in the running app's JavaScript context. The bridge plugin runs there with full API access; the MCP server is a thin, stdio-speaking client. Blockbench's plugin sandbox does not allow the `http` module, so the bridge uses a raw TCP (`net`) protocol bound to `127.0.0.1` only.

---

## Setup

### 1. Install the Blockbench plugin

1. Open the **Blockbench desktop app** (the bridge needs Node access, so it is desktop-only — not the web app).
2. `File ▸ Plugins ▸` (folder icon) **Load Plugin from File**.
3. Choose `mcp/plugin/blockbench_mcp_bridge.js`. **Do not rename the file** — Blockbench derives the plugin id from the filename, and it must stay `blockbench_mcp_bridge.js`.
4. The first time, Blockbench asks permission for **network access** (the `net` module). Click **Allow** (or *Always allow for this plugin*). This only opens a loopback socket on `127.0.0.1`; nothing is exposed to the internet.
5. You should see a toast: **“MCP Bridge listening on port 19888”**.

The plugin adds three commands (searchable via `Ctrl/Cmd+F` or the action search):
`MCP Bridge: Status`, `MCP Bridge: Restart Server`, `MCP Bridge: Set Port`.

> Loaded-from-file plugins are remembered and auto-load on the next launch.

#### Get the auth token

The bridge requires a shared token so that only your MCP server (not other local programs or web pages) can control Blockbench. Run **`MCP Bridge: Status`** in Blockbench and copy the **auth token** — you'll paste it into the MCP server config below as `BLOCKBENCH_MCP_TOKEN`. Treat it like a password.

### 2. Install the MCP server

```bash
cd mcp/server
npm install
```

Requires Node ≥ 18.

### 3. Point your MCP client at it

**Claude Desktop** — edit `claude_desktop_config.json`
(Windows: `%APPDATA%\Claude\claude_desktop_config.json`,
macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "blockbench": {
      "command": "node",
      "args": ["C:/Users/deadzi/Desktop/blockbench-master/mcp/server/index.js"],
      "env": {
        "BLOCKBENCH_MCP_TOKEN": "<paste the token from MCP Bridge: Status>"
      }
    }
  }
}
```

**Claude Code** (CLI):

```bash
claude mcp add blockbench --env BLOCKBENCH_MCP_TOKEN=<token> -- node C:/Users/deadzi/Desktop/blockbench-master/mcp/server/index.js
```

Restart the client. Keep Blockbench open with the plugin enabled — then ask your assistant to build something.

### Configuration (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `BLOCKBENCH_MCP_TOKEN` | *(required)* | Shared auth token — copy from `MCP Bridge: Status` |
| `BLOCKBENCH_MCP_PORT` | `19888` | TCP port (must match the plugin's port) |
| `BLOCKBENCH_MCP_HOST` | `127.0.0.1` | Bridge host |
| `BLOCKBENCH_MCP_TIMEOUT` | `60000` | Per-request timeout (ms) |

If you change the port in the plugin (`MCP Bridge: Set Port`), set `BLOCKBENCH_MCP_PORT` to match.

---

## Tools

| Tool | What it does |
|---|---|
| `bb_status` | Connection + current project summary (call this first) |
| `bb_list_formats` | List model formats (`bedrock`, `java_block`, `free`, …) |
| `bb_create_project` | Create a new project/tab of a format |
| `bb_get_project` | Project details + counts |
| `bb_save_project` | Save a `.bbmodel` to disk |
| `bb_export_model` | Export native format (Java/Bedrock JSON, glTF, OBJ…) to disk or as text |
| `bb_load_project` | Open a model from a path or raw content |
| `bb_add_cube` | Add a box (from/to, origin, rotation, parent, texture) |
| `bb_add_group` | Add a group/bone |
| `bb_add_mesh` | Add a free-form polygon mesh (vertices + faces) |
| `bb_edit_element` | Change geometry/pivot/rotation/name/visibility |
| `bb_delete_element` | Delete an element/group |
| `bb_duplicate_element` | Duplicate an element/group |
| `bb_set_parent` | Reparent an element/group |
| `bb_list_elements` | List all elements & groups with geometry |
| `bb_create_texture` | New blank (optionally filled) texture |
| `bb_list_textures` | List textures |
| `bb_import_texture` | Add a texture from PNG data/base64 |
| `bb_fill_texture` | Fill a whole texture with a color |
| `bb_paint_rect` | Paint a rectangle of pixels |
| `bb_paint_pixels` | Set individual pixels (pixel art) |
| `bb_get_texture` | **View** a texture as an image |
| `bb_apply_texture` | Assign a texture to a cube's faces |
| `bb_set_face_uv` | Set explicit UV on a cube face |
| `bb_auto_uv` | Auto-lay-out UVs |
| `bb_get_uv` | Read a cube's UV layout |
| `bb_create_animation` | Create + select an animation |
| `bb_list_animations` | List animations/bones/keyframes |
| `bb_select_animation` | Make an animation active |
| `bb_add_keyframe` | Add a rotation/position/scale keyframe to a bone |
| `bb_set_timeline_time` | Pose the model at a time (for rendering a frame) |
| `bb_render_view` | **Render** the model to a PNG (so the LLM can see it) |
| `bb_list_actions` | List **every** Blockbench command/tool/toggle/select (the full menu+toolbar feature set) |
| `bb_get_action` | Details about one command |
| `bb_run_action` | **Run any** Blockbench command by id (universal bridge to the whole feature set) |
| `bb_select` | Set what's selected (so selection-based commands act on the right things) |
| `bb_list_modes` / `bb_set_mode` | List / switch editor modes (edit, paint, animate, display) |
| `bb_list_settings` / `bb_get_setting` / `bb_set_setting` | Read/write any Blockbench setting |
| `bb_execute_script` | Run arbitrary Blockbench JS — the escape hatch for 100% coverage |

### Full coverage

The goal is that **everything** Blockbench can do is reachable over MCP. Three layers guarantee that:

1. **Dedicated tools** (above) for the common modeling/texturing/animation/render workflow.
2. **The universal action bridge** — every Blockbench feature is a registered command (`BarItem`). `bb_list_actions` enumerates all of them (undo, mirror, center, convert, parent, resolve, optimize, CEM/animation ops, view modes, every menu entry…), and `bb_run_action` invokes any of them by id — with `value` for toggles/selects/sliders. Combined with `bb_select`, `bb_set_mode`, and the settings tools, the entire UI is drivable.
3. **`bb_execute_script`** — arbitrary JS against the full Blockbench API for anything that needs custom logic.

So if a dedicated tool doesn't exist for something, `bb_list_actions` + `bb_run_action` almost certainly does — and `bb_execute_script` covers the rest.

### The escape hatch: `bb_execute_script`

Anything not covered by a dedicated tool can be done with raw Blockbench JS. The code is the body of an async function, so you can `await` and `return` a value:

```js
// returns the names of all cubes
return Cube.all.map(c => c.name);
```

```js
// bulk operation with proper undo
Undo.initEdit({ elements: Cube.all });
Cube.all.forEach(c => c.setColor(3));
Canvas.updateView({ elements: Cube.all, element_aspects: { faces: true } });
Undo.finishEdit('Recolor all');
return Cube.all.length;
```

It has full access to the Blockbench globals (`Cube`, `Group`, `Mesh`, `Texture`, `Animation`, `Undo`, `Canvas`, `Project`, `Format`, `BarItems`, `Outliner`, `Painter`, `Timeline`, …).

---

## Example session

> *"Make a Minecraft Bedrock chicken: white body, a head with a beak, two legs, and a simple idle bob animation."*

A capable client will roughly:
1. `bb_create_project` `{format:"bedrock", name:"chicken", texture_width:16, texture_height:16}`
2. `bb_add_group` for `body`, `head`, `leg_left`, `leg_right`
3. `bb_add_cube` for each part (parented to the right group)
4. `bb_create_texture` + `bb_paint_rect`/`bb_paint_pixels` for the skin, then `bb_apply_texture`
5. `bb_auto_uv`
6. `bb_render_view` to check the result, iterating on geometry/texture
7. `bb_create_animation` + `bb_add_keyframe` on `body`/`head`
8. `bb_set_timeline_time` + `bb_render_view` to preview a frame
9. `bb_save_project` / `bb_export_model`

---

## Troubleshooting

- **“Blockbench not reachable” / tools time out** — Is Blockbench open with the MCP Bridge plugin enabled? Run `MCP Bridge: Status` in Blockbench; it should say *running*. Make sure the port matches `BLOCKBENCH_MCP_PORT`.
- **“Invalid or missing token” / authentication failed** — Set `BLOCKBENCH_MCP_TOKEN` in your client config to the token shown by `MCP Bridge: Status`, then restart the client.
- **Plugin didn't load / no toast** — The file must be named `blockbench_mcp_bridge.js` (the id is derived from the filename). If you renamed it, rename it back and reload.
- **Port already in use (EADDRINUSE)** — Another Blockbench window already hosts the bridge. Close it, or use `MCP Bridge: Set Port` to pick a free port and set `BLOCKBENCH_MCP_PORT` to match.
- **“No project is open”** — Call `bb_create_project` first (or open a model).
- **Animation tools error** — The current format must support animation (e.g. `bedrock`, `modded_entity`). Create the project with such a format.
- **Permission was denied** — Re-enable the plugin and click *Allow* when asked for network access.
- **Changed the plugin code** — Use `File ▸ Plugins`, right-click the plugin, **Reload** (or the dev *Reload Plugins* action). The server is torn down and restarted cleanly.

## Security

The bridge listens on `127.0.0.1` only (not reachable from the network) **and** requires a shared token: every connection must complete an auth handshake whose first line is `{"type":"auth","token":...}` before any command is accepted. This has two effects:

- **Web pages can't reach it.** A cross-origin `fetch`/WebSocket always sends an HTTP preamble first; that first line fails to parse as the auth handshake, so the socket is dropped before any command runs — closing the drive-by/CSRF vector.
- **Other local programs need the token.** Without `BLOCKBENCH_MCP_TOKEN` they are rejected.

Still, `bb_execute_script` runs arbitrary code inside Blockbench (with file-system reach via the app), so **keep the token secret** and only enable the plugin when you intend to use it. To rotate the token, clear it in the browser console (`localStorage.removeItem('mcp_bridge_token')`) and reload the plugin; a new one is generated and shown in `MCP Bridge: Status`.

## Development

```bash
cd mcp/server
npm test          # end-to-end smoke test against a mock bridge (no Blockbench needed)
node --check ../plugin/blockbench_mcp_bridge.js
```

The method names and parameter shapes in `server/tools.js` are the contract that `plugin/blockbench_mcp_bridge.js` implements. To add a capability: add a handler in the plugin and a matching tool in `tools.js`.
