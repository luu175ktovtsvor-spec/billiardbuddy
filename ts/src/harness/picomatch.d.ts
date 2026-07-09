// picomatch 无自带类型声明(cc 靠 @types/picomatch;我们不引新依赖)。
// 这里补最小 ambient 声明,覆盖本仓库用到的 API(默认导出可调用 + .isMatch)。
declare module 'picomatch' {
  interface PicomatchOptions {
    dot?: boolean
    nocase?: boolean
    [key: string]: unknown
  }
  interface Picomatch {
    (glob: string | string[], options?: PicomatchOptions): (str: string) => boolean
    isMatch(str: string, patterns: string | string[], options?: PicomatchOptions): boolean
  }
  const picomatch: Picomatch
  export default picomatch
}
