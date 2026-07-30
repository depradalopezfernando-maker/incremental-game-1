/// <reference types="vite/client" />

/**
 * CSS Modules. Vite handles the transform; this is the type surface.
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
