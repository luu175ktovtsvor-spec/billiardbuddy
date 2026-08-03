// Shared runner for every TypeScript test. Test cases still own their own
// temporary directories and must close SQLite handles before cleanup.
process.env.NODE_ENV = 'test'
