/* Karma configuration for standalone build */

// import NodePolyfillPlugin from 'node-polyfill-webpack-plugin';
import puppeteer from 'puppeteer';
import webpack from 'webpack';
// import webpack from 'webpack';

process.env.CHROME_BIN = puppeteer.executablePath();

module.exports = function (config) {
    console.log();
    console.log('Browser Tests');
    console.log();

    config.set({
        autoWatch: false,
        basePath: '..',
        browsers: ['HeadlessChrome'],
        customLaunchers: {
            HeadlessChrome: {
                base: 'ChromeHeadless',
                flags: ['--no-sandbox', '--disable-web-security'],
            },
        },
        frameworks: ['webpack', 'mocha'],
        reporters: ['mocha', 'coverage-istanbul'],
        singleRun: true,
        files: [
            {pattern: '../test/test-json-refs.ts', watch: false},
            {pattern: './browser/documents/**/*', watched: false, included: false},
        ],
        client: {
            mocha: {
                reporter: 'html',
                timeout: 10000,
                ui: 'bdd',
            },
        },
        plugins: [
            'karma-chrome-launcher',
            'karma-coverage-istanbul-reporter',
            'karma-source-map-support',
            'karma-mocha',
            'karma-mocha-reporter',
            'karma-typescript',
            'karma-webpack',
        ],
        preprocessors: {
            '../test/test-json-refs.ts': ['webpack'],
        },
        webpack: {
            mode: 'development',
            devtool: 'eval-cheap-module-source-map',
            plugins: [
                new webpack.ProvidePlugin({
                    process: 'process/browser',
                }),
            ],
            module: {
                rules: [
                    {
                        test: /yaml\.js$/,
                        use: 'transform-loader?brfs',
                        exclude: /node_modules/,
                    },
                    {
                        test: /\.tsx?$/,
                        use: 'ts-loader',
                        exclude: /node_modules/,
                    },
                    {
                        test: /\.ts$/,
                        exclude: /test/,
                        enforce: 'post',
                        use: {
                            loader: 'istanbul-instrumenter-loader',
                            options: {esModules: true},
                        },
                    },
                ],
            },
            resolve: {
                extensions: ['.js', '.ts'],
                alias: {
                    process: 'process/browser',
                    //   'path-loader': 'path-loader/dist/path-loader.js'
                },
                fallback: {fs: false, path: require.resolve('path-browserify')},
                // "crypto": false , "buffer": require.resolve("buffer/"), "zlib": false, "tty": false, "stream": false, "domain": false, "querystring": false,"http": false , "https": false ,"path": false, "os": false }
            },
        },
        webpackMiddleware: {
            stats: 'errors-details',
        },
        coverageIstanbulReporter: {
            reports: ['lcov'],
            dir: '.coverage/karma',
            fixWebpackSourcePaths: true,
            'report-config': {
                html: {outdir: 'html'},
            },
        },
    });
};
