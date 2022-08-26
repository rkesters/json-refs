'use strict';

var path = require('path');

module.exports = [{
  devtool: 'inline-source-map',
  entry: './src/index.ts',
  mode: 'development',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      }
    ]
  },
  name: 'json-refs',
  optimization: {
    minimize: false
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'json-refs.js',
    library: 'JsonRefs'
  }
}, {
  entry: './src/index.ts',
  mode: 'production',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      }
    ]
  },
  name: 'json-refs-min',
  optimization: {
    minimize: true
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'json-refs-min.js',
    library: 'JsonRefs'
  }
}];
