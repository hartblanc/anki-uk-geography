module.exports = {
  multipass: true,
  floatPrecision: 1,
  plugins: [
    {
      name: "preset-default",
      params: {
        overrides: {
          cleanupIds: false,
          // Keep layer <g> wrappers: maps.js extracts layers by group id, so
          // single-element layers must not be collapsed to a bare path.
          collapseGroups: false,
        },
      },
    },
  ],
};
