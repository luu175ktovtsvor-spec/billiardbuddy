const STYLE_ID = 'bb-video-workbench-styles'

const styles = `
  .bb-video-workbench {
    --bb-video-bg: #171b1b;
    --bb-video-panel: #202625;
    --bb-video-line: #3a4542;
    --bb-video-text: #edf2ef;
    --bb-video-muted: #a8b3ae;
    --bb-video-accent: #20b486;
    --bb-video-warning: #e2a832;
    --bb-video-danger: #e25c5c;
    --bb-video-info: #58a6d8;
    box-sizing: border-box;
    display: grid;
    grid-template-columns: 196px minmax(0, 1fr);
    min-height: 100%;
    color: var(--bb-video-text);
    background: var(--bb-video-bg);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    letter-spacing: 0;
  }
  .bb-video-workbench *, .bb-video-workbench *::before, .bb-video-workbench *::after { box-sizing: border-box; }
  .bb-video-nav {
    display: grid;
    align-content: start;
    gap: 2px;
    padding: 12px 8px;
    border-right: 1px solid var(--bb-video-line);
    background: #141817;
  }
  .bb-video-nav-item, .bb-video-action {
    border: 1px solid transparent;
    border-radius: 6px;
    min-height: 34px;
    padding: 6px 9px;
    color: inherit;
    background: transparent;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .bb-video-nav-item:hover, .bb-video-action:hover:not(:disabled) { border-color: var(--bb-video-line); background: #2a3431; }
  .bb-video-nav-item.is-active { color: #061811; background: var(--bb-video-accent); font-weight: 650; }
  .bb-video-main { min-width: 0; padding: 22px clamp(16px, 3vw, 44px) 40px; }
  .bb-video-header { display: flex; justify-content: space-between; gap: 20px; align-items: baseline; padding-bottom: 16px; border-bottom: 1px solid var(--bb-video-line); }
  .bb-video-header h1, .bb-video-section h2 { margin: 0; font-weight: 650; }
  .bb-video-header h1 { font-size: 20px; }
  .bb-video-section h2 { font-size: 15px; }
  .bb-video-status, .bb-video-summary, .bb-video-notice { margin: 0; color: var(--bb-video-muted); }
  .bb-video-status.is-failed, .bb-video-notice { color: #ffd2d2; }
  .bb-video-status.is-stale, .bb-video-status.is-needs-user-decision { color: #ffd98d; }
  .bb-video-section { padding: 20px 0; border-bottom: 1px solid var(--bb-video-line); }
  .bb-video-subsection { margin-top: 18px; padding: 14px 0 0; border-top: 1px solid var(--bb-video-line); }
  .bb-video-subsection h2 { font-size: 13px; color: var(--bb-video-muted); }
  .bb-video-list { display: grid; gap: 6px; margin: 12px 0 0; padding: 0; list-style: none; }
  .bb-video-row, .bb-video-operation {
    display: grid;
    grid-template-columns: minmax(140px, 1fr) minmax(112px, auto) minmax(96px, auto);
    align-items: center;
    gap: 12px;
    min-height: 42px;
    padding: 8px 10px;
    border-left: 3px solid var(--bb-video-line);
    background: var(--bb-video-panel);
  }
  .bb-video-operation { grid-template-columns: minmax(120px, 1fr) minmax(140px, 2fr) 56px auto; }
  .bb-video-row span, .bb-video-operation span { color: var(--bb-video-muted); }
  .bb-video-row.is-passed, .bb-video-summary.is-passed { border-color: var(--bb-video-accent); }
  .bb-video-row.is-blocked, .bb-video-row.is-failed, .bb-video-summary.is-blocked { border-color: var(--bb-video-danger); }
  .bb-video-row.is-needs-user-decision, .bb-video-row.is-stale { border-color: var(--bb-video-warning); }
  .bb-video-row.is-locked { border-color: var(--bb-video-info); }
  .bb-video-row.is-selected { outline: 1px solid var(--bb-video-accent); outline-offset: -1px; background: #263b34; }
  .bb-video-row[role="button"] { cursor: pointer; }
  .bb-video-row[role="button"]:focus-visible, .bb-video-selection:focus-visible { outline: 2px solid var(--bb-video-info); outline-offset: 2px; }
  .bb-video-empty { padding: 10px 0; color: var(--bb-video-muted); }
  .bb-video-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .bb-video-selection-list { display: flex; flex-wrap: wrap; gap: 6px; grid-column: 1 / -1; }
  .bb-video-selection { min-height: 28px; border: 1px solid var(--bb-video-line); border-radius: 4px; padding: 4px 7px; color: var(--bb-video-muted); background: #1a201e; font: inherit; cursor: pointer; }
  .bb-video-selection.is-selected { color: #061811; border-color: var(--bb-video-accent); background: var(--bb-video-accent); }
  .bb-video-action { border-color: var(--bb-video-line); background: #26302d; text-align: center; }
  .bb-video-action:disabled { color: #68736f; border-color: #303936; background: #1d2220; cursor: not-allowed; }
  .bb-video-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, max-content)); gap: 4px 18px; margin: 12px 0 0; }
  .bb-video-metrics dt { color: var(--bb-video-muted); }
  .bb-video-metrics dd { margin: 0; font-weight: 650; }
  @media (max-width: 720px) {
    .bb-video-workbench { grid-template-columns: 1fr; }
    .bb-video-nav { grid-template-columns: repeat(4, minmax(0, 1fr)); border-right: 0; border-bottom: 1px solid var(--bb-video-line); overflow-x: auto; }
    .bb-video-nav-item { min-width: 0; white-space: nowrap; }
    .bb-video-main { padding: 16px; }
    .bb-video-header { display: grid; gap: 6px; }
    .bb-video-row, .bb-video-operation { grid-template-columns: minmax(0, 1fr) auto; }
    .bb-video-row span:first-of-type, .bb-video-operation span:first-of-type { grid-column: 1; }
    .bb-video-actions { grid-column: 1 / -1; }
  }
`

/** Injected only when the isolated video surface is mounted. */
export function installVideoWorkbenchStyles(document_: Document = document): void {
  if (document_.getElementById(STYLE_ID)) return
  const style = document_.createElement('style')
  style.id = STYLE_ID
  style.textContent = styles
  document_.head.append(style)
}
