export const CODEX_ENGINE_MANIFEST_SCHEMA = 3 as const
export const CODEX_ENGINE_NAME = 'codex-app-server' as const
export const CODEX_ENGINE_SOURCE_REPOSITORY = 'https://github.com/openai/codex' as const
export const CODEX_ENGINE_SOURCE_REVISION = '2b5bdcf67547860f2e5c5a605009a70026796b2b' as const

/**
 * Product-owned changes to the pinned Codex source. The staged engine manifest
 * and Electron's launch gate both require this exact reviewed patch set.
 */
export const CODEX_ENGINE_PRODUCT_PATCHES = [
  {
    file: '0001-sanitize-hook-environment.patch',
    sha256: '426e98622ee3b8888971ac62e925ce458ab53eca707acc4d9198105c5aa6c06c',
  },
  {
    file: '0002-sanitize-non-tool-child-environment.patch',
    sha256: 'e238e9dcd38cdfe59eac0dc777afd6cae82db3ec771d1b63aaa7c82abd993f74',
  },
  {
    file: '0003-sanitize-legacy-notify-environment.patch',
    sha256: '3211c7a155b50d37f7fa2eb002b256300e078968bf6f977d5ff2c51b115ee368',
  },
] as const

export type CodexEngineProductPatch = {
  file: string
  sha256: string
}
