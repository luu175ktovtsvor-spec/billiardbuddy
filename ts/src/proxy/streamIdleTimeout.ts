// 国产模型/慢链路流卡死时的空闲超时兜底。
export function withStreamIdleTimeout(
  upstream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): ReadableStream<Uint8Array> {
  // reader 类型不显式写 ReadableStreamDefaultReader<Uint8Array>(ambient 全局类型在本工程下与
  // upstream.getReader() 实际推导类型——node:stream/web 版本——对不上、缺 readMany);改用 ReturnType 派生同源类型。
  type Reader = ReturnType<typeof upstream.getReader>
  let reader: Reader | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const clearIdleTimer = () => { if (timer) { clearTimeout(timer); timer = null } }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = upstream.getReader()
      let timedOut = false
      const arm = () => {
        clearIdleTimer()
        timer = setTimeout(() => {
          timedOut = true
          void reader?.cancel('stream idle timeout').catch(() => undefined)
          controller.error(new Error(`Upstream stream idle timeout after ${timeoutMs}ms`))
        }, timeoutMs)
      }
      try {
        arm()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (timedOut) break
          controller.enqueue(value)
          arm()
        }
        clearIdleTimer()
        if (!timedOut) controller.close()
      } catch (err) {
        clearIdleTimer()
        if (!timedOut) controller.error(err)
      }
    },
    cancel(reason) { clearIdleTimer(); return reader?.cancel(reason) },
  })
}
