import {writeFileSync} from 'node:fs';
import {openapi} from '../dist/src/openapi.js';
writeFileSync('openapi.json',JSON.stringify(openapi,null,2)+'\n');
console.log(`Exported ${Object.keys(openapi.paths).length} API paths to openapi.json`);
