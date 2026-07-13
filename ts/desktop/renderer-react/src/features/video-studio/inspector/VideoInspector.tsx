import type { VideoAlternative, VideoOperation, VideoProject, VideoScene } from '../../../api/video'
import { Alternatives } from '../alternatives/Alternatives'
import { SceneVisualControls } from '../workbench/SceneEditor'
import { inputStyle, primaryButtonStyle, subtleButtonStyle } from '../videoStudioStyles'

export function VideoInspector({
  project,
  selectedScene,
  sceneCount,
  busy,
  musicLicense,
  renderUrl,
  onMusicLicenseChange,
  onApplyAlternative,
  onOperation,
  onSetGraphicText,
  onPickLogo,
  onPickMusic,
  onRender,
}: {
  project: VideoProject
  selectedScene?: VideoScene
  sceneCount: number
  busy: boolean
  musicLicense: string
  renderUrl: string
  onMusicLicenseChange: (value: string) => void
  onApplyAlternative: (alternative: VideoAlternative, scope: 'whole' | 'scene') => void
  onOperation: (operation: VideoOperation) => void
  onSetGraphicText: (text: string) => void
  onPickLogo: () => void
  onPickMusic: () => void
  onRender: (preview: boolean) => void
}) {
  return (
    <div className="space-y-5">
      <Alternatives alternatives={project.alternatives} selectedSceneId={selectedScene?.id} onApply={onApplyAlternative} />
      {selectedScene && <section className="border-t pt-4" style={{ borderColor: 'var(--color-border)' }}>
        <div className="mb-2 flex items-center justify-between text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}><span>当前片段</span><span>{selectedScene.order + 1}</span></div>
        <button type="button" onClick={() => onOperation({ type: 'scene.set_locked', scene_id: selectedScene.id, locked: !selectedScene.locked_by_user })} className="w-full rounded-md px-2 py-1.5 text-[12px]" style={subtleButtonStyle}>{selectedScene.locked_by_user ? '继续修改这一段' : '这段不再改动'}</button>
        <label className="mt-3 block text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>画面文字
          <input defaultValue={selectedScene.graphics.find(item => item.role !== 'subtitle')?.text ?? ''} key={`${selectedScene.id}-graphic`} onBlur={event => onSetGraphicText(event.target.value.trim())} className="mt-1 w-full rounded-md px-2 py-2 text-[12px] outline-none" style={inputStyle} placeholder="标题、重点或行动提示" />
        </label>
        <label className="mt-3 block text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>片段衔接
          <select value={selectedScene.transition_in.kind} onChange={event => onOperation({ type: 'scene.set_transition', scene_id: selectedScene.id, transition: event.target.value === 'dissolve' ? { kind: 'dissolve', duration_ms: 300, reason: '用户选择柔和连接相邻片段' } : { kind: 'cut', duration_ms: 0 } })} className="mt-1 w-full rounded-md px-2 py-2 text-[12px]" style={inputStyle}><option value="cut">直接切换</option><option value="dissolve">柔和过渡</option></select>
        </label>
        <details className="mt-3">
          <summary className="cursor-pointer text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>画面位置与速度</summary>
          <SceneVisualControls scene={selectedScene} onOperation={onOperation} />
        </details>
      </section>}
      <details className="border-t pt-4" style={{ borderColor: 'var(--color-border)' }}>
        <summary className="cursor-pointer text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>片尾、Logo 和音乐</summary>
        <div className="mt-3">
          <label className="block text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>项目名称<input defaultValue={project.name} key={`${project.project_id}-${project.name}`} onBlur={event => event.target.value.trim() && event.target.value.trim() !== project.name && onOperation({ type: 'project.set_name', name: event.target.value.trim() })} className="mt-1 w-full rounded-md px-2 py-2 text-[12px] outline-none" style={inputStyle} /></label>
          <label className="mt-3 block text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>整体感觉<select value={project.brand.preset} onChange={event => onOperation({ type: 'project.set_brand', brand: { ...project.brand, preset: event.target.value as 'neutral' | 'clean' | 'energetic' } })} className="mt-1 w-full rounded-md px-2 py-2 text-[12px]" style={inputStyle} aria-label="整体感觉"><option value="neutral">自然</option><option value="clean">简洁</option><option value="energetic">有活力</option></select></label>
          <button type="button" onClick={onPickLogo} className="mt-3 w-full rounded-md px-2 py-2 text-[12px]" style={subtleButtonStyle}>{project.brand.logo_path ? '更换 Logo' : '添加 Logo'}</button>
          <input defaultValue={project.brand.cta_text ?? ''} key={`${project.project_id}-${project.brand.cta_text ?? ''}`} onBlur={event => event.target.value.trim() !== (project.brand.cta_text ?? '') && onOperation({ type: 'project.set_brand', brand: { ...project.brand, cta_text: event.target.value.trim() || undefined } })} placeholder="片尾提示语（可选）" className="mt-3 w-full rounded-md px-2 py-2 text-[12px] outline-none" style={inputStyle} />
          <input value={musicLicense} onChange={event => onMusicLicenseChange(event.target.value)} placeholder="音乐来源或授权说明" className="mt-2 w-full rounded-md px-2 py-2 text-[12px] outline-none" style={inputStyle} />
          <button type="button" onClick={onPickMusic} className="mt-2 w-full rounded-md px-2 py-2 text-[12px]" style={subtleButtonStyle}>{project.music.path ? '更换音乐' : '选择音乐'}</button>
          {project.music.path && <div className="mt-2 grid grid-cols-2 gap-2"><button type="button" onClick={() => onOperation({ type: 'project.set_music', music: { ...project.music, enabled: !project.music.enabled } })} className="rounded-md px-2 py-2 text-[12px]" style={subtleButtonStyle}>{project.music.enabled ? '关闭音乐' : '启用音乐'}</button><button type="button" onClick={() => onOperation({ type: 'project.set_music', music: { energy: project.music.energy, enabled: false } })} className="rounded-md px-2 py-2 text-[12px]" style={subtleButtonStyle}>移除音乐</button></div>}
          <label className="mt-3 block text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>音乐感觉<select value={project.music.energy} onChange={event => onOperation({ type: 'project.set_audio_intent', energy: event.target.value as 'calm' | 'natural' | 'lively' | 'crisp', music_enabled: project.music.enabled })} className="mt-1 w-full rounded-md px-2 py-2 text-[12px]" style={inputStyle} aria-label="音乐感觉"><option value="calm">舒缓</option><option value="natural">自然</option><option value="lively">活力</option><option value="crisp">利落</option></select></label>
        </div>
      </details>
      <section className="border-t pt-4" style={{ borderColor: 'var(--color-border)' }}>
        <div className="mb-2 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>完成视频</div>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" disabled={busy || sceneCount === 0 || !selectedScene} onClick={() => onRender(true)} className="rounded-md px-2 py-2 text-[12px] disabled:opacity-40" style={subtleButtonStyle} data-testid="video-preview-render">预览当前片段</button>
          <button type="button" disabled={busy || sceneCount === 0} onClick={() => onRender(false)} className="rounded-md px-2 py-2 text-[12px] font-medium disabled:opacity-40" style={primaryButtonStyle} data-testid="video-final-render">生成完整视频</button>
        </div>
        {renderUrl && <a href={renderUrl} download className="mt-2 block rounded-md px-2 py-2 text-center text-[12px]" style={subtleButtonStyle} data-testid="video-download">下载视频</a>}
      </section>
    </div>
  )
}
