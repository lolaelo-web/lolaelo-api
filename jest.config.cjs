/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.(cjs|js)"],
  transform: {},                // no transforms needed for CJS
  transformIgnorePatterns: ["/node_modules/"]
};
