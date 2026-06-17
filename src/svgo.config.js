module.exports = {
  multipass: true,
  floatPrecision: 1,
  js2svg: {
    indent: 2, // string with spaces or number of spaces. 4 by default
    pretty: true, // boolean, false by default
  },
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
