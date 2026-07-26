export function ProductPrivacySettings() {
  return (
    <section className="max-w-2xl" aria-labelledby="product-privacy-title">
      <h2 id="product-privacy-title" className="mb-2 text-base font-semibold text-[var(--color-text-primary)]">远程处理说明</h2>
      <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4 text-sm leading-6 text-[var(--color-text-secondary)]">
        <p>聊天、图片理解、图片生成、语音转写和工作台媒体推理会在使用对应功能时，将完成该操作所必需的内容发送到 BilliardBuddy 的受管远程服务。</p>
        <p>远程调用受安装身份、普通工具权限、用量额度、超时、取消和幂等约束；不会在每个回合或每次媒体操作前反复要求确认。</p>
        <p>本机项目真相、媒体项目状态和导出结果仍由本地应用管理；远程服务只接收完成当前请求需要的最小输入。</p>
      </div>
    </section>
  )
}
