const { contextBridge, ipcRenderer } = require("electron");
const INVOKE = ["auth:restore","auth:login","auth:logout","instances:list","instances:install","update:apply","custom:versions","custom:loaders","custom:list","custom:create","custom:delete","instance:rename","custom:open","app:version","library:search","library:install","library:open","artwork:set","artwork:clear","instance:ram:get","instance:ram:set","instance:files","instance:open-folder","instance:remove-local","instance:logs:start","instance:logs:stop","minecraft:play","minecraft:logout"];
const ON = ["progress","installed","update-available","game-log","launcher-log","game-state"];
contextBridge.exposeInMainWorld("nexia", {
  invoke: (ch, ...a) => INVOKE.includes(ch) ? ipcRenderer.invoke(ch, ...a) : Promise.reject(new Error("blocked")),
  on: (ch, fn) => { if (!ON.includes(ch)) return; ipcRenderer.on(ch, (_e, d) => fn(d)); }
});
