import type { VideoAlternative } from '../../../api/video'
import { subtleButtonStyle } from '../videoStudioStyles'

export function Alternatives({ alternatives, selectedSceneId, onApply }: { alternatives: VideoAlternative[]; selectedSceneId?: string; onApply: (alternative: VideoAlternative, scope: 'whole' | 'scene') => void }) {
  return (
    <section data-testid="video-alternatives">
      <div className="mb-2 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>候选方案</div>
      <div className="space-y-2">
        {alternatives.map(alternative => (
          <div key={alternative.id} className="rounded-md p-2.5" style={{ border: '1px solid var(--color-border)' }}>
            <div className="text-[12px] font-medium" style={{ color: 'var(--color-text-primary)' }}>{alternative.name}</div>
            <div className="mt-1 text-[10px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{alternative.tradeoff}</div>
            <div className="mt-2 flex gap-1.5">
              <button type="button" onClick={() => onApply(alternative, 'whole')} className="rounded-md px-2 py-1 text-[10px]" style={subtleButtonStyle}>采用整版</button>
              {selectedSceneId && alternative.changed_scene_ids.includes(selectedSceneId) && <button type="button" onClick={() => onApply(alternative, 'scene')} className="rounded-md px-2 py-1 text-[10px]" style={subtleButtonStyle}>只采用当前 Scene</button>}
            </div>
          </div>
        ))}
        {!alternatives.length && <div className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>生成草稿后会出现 3 个可解释候选。</div>}
      </div>
    </section>
  )
}
