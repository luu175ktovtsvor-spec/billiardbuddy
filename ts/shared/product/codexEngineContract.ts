export const CODEX_ENGINE_MANIFEST_SCHEMA = 6 as const
/** Upstream Cargo package and binary name. Never exposed as a product resource name. */
export const CODEX_ENGINE_NAME = 'codex-app-server' as const
/** Exact companion name resolved by the locked Core beside the App Server. */
export const CODEX_CODE_MODE_HOST_NAME = 'codex-code-mode-host' as const
/** BilliardBuddy's packaged Agent Engine resource name. */
export const BILLIARDBUDDY_AGENT_ENGINE_NAME = 'billiardbuddy-agent-engine' as const
export const CODEX_ENGINE_SOURCE_REPOSITORY = 'https://github.com/openai/codex' as const
export const CODEX_ENGINE_SOURCE_REVISION = '2b5bdcf67547860f2e5c5a605009a70026796b2b' as const

/**
 * Product-owned changes to the pinned Codex source. The staged engine manifest
 * and Electron's launch gate both require this exact reviewed patch set.
 */
export const CODEX_ENGINE_PRODUCT_PATCHES = [
  {
    file: '0001-sanitize-hook-environment.patch',
    sha256: '62ba01f3a3ad766f8f1edb2f195b83aad2c49932039a59ac69ebca75fded0cca',
  },
  {
    file: '0002-sanitize-non-tool-child-environment.patch',
    sha256: '9ddb1fd55cc009ff0a9c445dde9e576ebc92d8361dffbc2c2f0becaf920eb77c',
  },
] as const

export type CodexEngineProductPatch = {
  file: string
  sha256: string
}
