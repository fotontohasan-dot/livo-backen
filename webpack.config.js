const path = require('path');

module.exports = {
  mode: 'production',
  entry: './app.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js',
  },
  target: 'node',
  externals: {
    express: 'commonjs express',
    pg: 'commonjs pg',
    ejs: 'commonjs ejs',
    'express-session': 'commonjs express-session',
    'connect-flash': 'commonjs connect-flash',
    bcryptjs: 'commonjs bcryptjs',
    dotenv: 'commonjs dotenv'
  }
};
