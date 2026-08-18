import { defineConfig } from "vitest/config";

/** Worker 单元测试使用 Node Web API；D1 与 R2 由测试内的最小契约桩隔离。 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
