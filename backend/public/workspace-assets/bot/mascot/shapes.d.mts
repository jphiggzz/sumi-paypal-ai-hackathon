export const COUNT: number;
export const ease: (value: number) => number;
export const settle: (value: number) => number;
export const profiles: Record<string, number[]>;
export const blend: (from: number[], to: number[], progress: number) => number[];
export const contour: (radii: number[]) => string;
