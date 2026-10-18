import 'dotenv/config';
import {setupMongoDatabase} from '../src/database.js';
const result=await setupMongoDatabase();console.log(`MongoDB indexes ready (${result.collections} application collections).`);
