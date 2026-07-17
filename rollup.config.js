import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { terser } from "rollup-plugin-terser";

export default {
  input: "src/index.tsx",
  output: { dir: "dist", format: "cjs", sourcemap: true },
  external: ["react", "react/jsx-runtime", "@decky/ui", "@decky/api"],
  plugins: [resolve(), commonjs(), typescript(), terser()]
};
