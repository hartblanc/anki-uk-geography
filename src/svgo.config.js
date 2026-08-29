module.exports = {
  multipass: true,
  floatPrecision: 1,
  plugins: [
    {
      name: "preset-default",
      params: {
        overrides: {
          cleanupIds: false,
        },
      },
    },
  ],
};
