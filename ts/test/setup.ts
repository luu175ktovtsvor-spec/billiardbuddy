// Shared runner for every TypeScript test. Test cases still own their own
// temporary directories and must close SQLite handles before cleanup.
process.env.NODE_ENV = 'test'
// A fixture-only Sidecar/Relay shared signer. Individual production paths
// still fail closed when their deployment environment omits this secret.
process.env.BB_VIDEO_REMOTE_CONSENT_SIGNING_KEY ??= 'test-video-remote-consent-signing-key-000000000000000000000000'
// Tests use a declared fixture font path. Production never searches host font
// registries; installers provide the reviewed font in runtime-assets/fonts.
if (!process.env.BB_IMAGE_FORMAL_FONT_PATH) {
  process.env.BB_IMAGE_FORMAL_FONT_PATH = `${process.cwd()}/node_modules/@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff`
}
