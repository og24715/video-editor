declare module "gifenc" {
  export interface GifFrameOptions {
    transparent?: boolean;
    transparentIndex?: number;
    delay?: number;
    palette?: number[][] | null;
    repeat?: number;
    first?: boolean;
    dispose?: number;
  }

  export interface GifEncoderInstance {
    writeFrame: (index: Uint8Array, width: number, height: number, opts?: GifFrameOptions) => void;
    finish: () => void;
    bytes: () => Uint8Array;
    reset: () => void;
  }

  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): GifEncoderInstance;

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: { format?: string },
  ): number[][];

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: string,
  ): Uint8Array;
}
