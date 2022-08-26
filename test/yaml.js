const fs = require('fs');
const YAML  = require ('js-yaml');
const path   =  require ('path');

const circularChild = YAML.load(
  fs.readFileSync(
    path.join(__dirname, 'browser', 'documents', 'circular-child.yaml'),
    'utf-8'
  )
);
const circularLocal = YAML.load(
  fs.readFileSync(
    path.join(__dirname, 'browser', 'documents', 'circular-local.yaml'),
    'utf-8'
  )
);
const circularRoot = YAML.load(
  fs.readFileSync(
    path.join(__dirname, 'browser', 'documents', 'circular-root.yaml'),
    'utf-8'
  )
);

const testDocument = YAML.load(
  fs.readFileSync(
    path.join(__dirname, 'browser', 'documents', 'test-document.yaml'),
    'utf-8'
  )
);
const testDocument1 = YAML.load(
  fs.readFileSync(
    path.join(__dirname, 'browser', 'documents', 'test-document-1.yaml'),
    'utf-8'
  )
);
const testDocumentSame = YAML.load(
  fs.readFileSync(
    path.join(__dirname, 'browser', 'documents', 'test-document-same.yaml'),
    'utf-8'
  )
);
const testNestedDocument = YAML.load(
  fs.readFileSync(
    path.join(__dirname, 'browser', 'documents', 'nested', 'test-nested.yaml'),
    'utf-8'
  )
);
const testNestedDocument1 = YAML.load(
  fs.readFileSync(
    path.join(
      __dirname,
      'browser',
      'documents',
      'nested',
      'test-nested-1.yaml'
    ),
    'utf-8'
  )
);
const testTypesDocument = YAML.load(
  fs.readFileSync(
    path.join(__dirname, 'browser', 'documents', 'test-types.yaml'),
    'utf-8'
  )
);

module.exports = {
  circularChild,
  circularLocal,
  circularRoot,
  testDocument,
  testDocument1,
  testDocumentSame,
  testNestedDocument,
  testNestedDocument1,
  testTypesDocument,
};
