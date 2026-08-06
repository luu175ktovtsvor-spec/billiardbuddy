import type {
  PublicMediaJobEventPage,
  PublicMediaTask,
  PublicVideoFactPage,
  PublicVideoFactSearchPage,
} from '../../shared/contracts/media.js'
import type {
  VideoWorkbenchIpcResponse,
  VideoWorkbenchPreloadBridge,
  VideoWorkbenchProjectProjection,
  VideoWorkbenchSnapshot,
} from '../../shared/contracts/videoWorkbenchPreload.js'

type Equal<Left, Right> = (
  <Value>() => Value extends Left ? 1 : 2
) extends (
  <Value>() => Value extends Right ? 1 : 2
) ? true : false
type Assert<Value extends true> = Value
type VideoPreload = Window['billiardBuddyNative']['media']['videos']

/** Compile-time proof that the video bridge never regresses to Promise<unknown>. */
export type VideoWorkbenchPreloadTypeContract = [
  Assert<Equal<VideoPreload, VideoWorkbenchPreloadBridge>>,
  Assert<Equal<ReturnType<VideoPreload['listProjects']>, Promise<VideoWorkbenchIpcResponse<readonly VideoWorkbenchProjectProjection[]>>>>,
  Assert<Equal<ReturnType<VideoPreload['loadWorkspace']>, Promise<VideoWorkbenchIpcResponse<VideoWorkbenchSnapshot>>>>,
  Assert<Equal<ReturnType<VideoPreload['loadOperationEvents']>, Promise<VideoWorkbenchIpcResponse<PublicMediaJobEventPage>>>>,
  Assert<Equal<ReturnType<VideoPreload['loadFacts']>, Promise<VideoWorkbenchIpcResponse<PublicVideoFactPage>>>>,
  Assert<Equal<ReturnType<VideoPreload['searchFacts']>, Promise<VideoWorkbenchIpcResponse<PublicVideoFactSearchPage>>>>,
  Assert<Equal<ReturnType<VideoPreload['createQuickDraft']>, Promise<VideoWorkbenchIpcResponse<PublicMediaTask>>>>,
]
