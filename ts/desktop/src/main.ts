const root = document.getElementById('root')

if (!root) {
  throw new Error('BILLIARDBUDDY_RENDERER_ROOT_MISSING')
}

// The renderer is intentionally empty until the new product surface is built
// from the Rust Thread/Turn/Item protocol.
root.replaceChildren()
