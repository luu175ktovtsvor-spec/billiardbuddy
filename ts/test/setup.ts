// Shared runner for every TypeScript test. Test cases still own their own
// temporary directories and must close SQLite handles before cleanup.
process.env.NODE_ENV = 'test'
// Tests use a declared fixture font path. Production never searches host font
// registries; installers provide the reviewed font in runtime-assets/fonts.
if (!process.env.BB_IMAGE_FORMAL_FONT_PATH) {
  process.env.BB_IMAGE_FORMAL_FONT_PATH = `${process.cwd()}/node_modules/@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff`
}
