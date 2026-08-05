export type ImageApplicationMethod<Port extends object, Name extends keyof Port> =
  Port[Name] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Result
    : never

/**
 * Each Application receives a scoped use-case port, not the complete runtime.
 * The runtime is only the composition-time source of these bound methods; a
 * caller cannot reach another application's commands through this object.
 */
export abstract class ImageApplication<Port extends object> {
  readonly #port: Port

  protected constructor(port: Port) {
    this.#port = port
  }

  protected bind<Name extends keyof Port>(name: Name): ImageApplicationMethod<Port, Name> {
    const member = this.#port[name]
    if (typeof member !== 'function') throw new Error(`Image application use case ${String(name)} is not callable`)
    return member as ImageApplicationMethod<Port, Name>
  }
}
