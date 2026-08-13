// doubao-vision-entry.mjs — stable loader shim for the host-level row in
// $DSH_HOME/cordis.patch.yml. The real implementation lives beside this file
// in doubao-vision.mjs; a broken/renamed implementation degrades to a no-op
// plugin instead of failing this profile's boot (the patch layer applies to
// every profile, so a load error here would otherwise block all of them).
let plugin
try {
  // The ?v=N suffix busts the ESM cache so an edited implementation loads
  // without a process restart; bump it together with the row name in
  // cordis.patch.yml whenever doubao-vision.mjs changes.
  plugin = (await import('./doubao-vision.mjs?v=18')).default
} catch (error) {
  console.warn('[doubao-vision] failed to load doubao-vision.mjs: ' + String((error && error.message) || error))
  plugin = { name: 'doubao-vision', apply() {} }
}
export { plugin as default }
