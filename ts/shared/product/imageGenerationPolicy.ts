/**
 * Product spending policy for the image workbench.
 *
 * Provider catalogs and the low-level image Relay may still describe a
 * larger protocol capability for historical compatibility. The product's
 * paid workflow deliberately requests exactly one output per operation.
 */
export const IMAGE_PRODUCT_OUTPUT_COUNT = 1 as const
