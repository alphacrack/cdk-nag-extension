import './extension.test';

// Register the test suites
require('mocha').setup({
  ui: 'bdd',
  timeout: 10000,
});

// Import all test files
require('./extension.test');
