import {createDatabase} from '../src/database.js';
import {catalogueSchema,ensureCatalogueCollection} from '../src/catalogue.js';
import {catalogueDrafts} from '../src/catalogue-drafts.js';
const db=createDatabase();
try{await db.$connect();await ensureCatalogueCollection(db);for(const draft of catalogueDrafts){const data=catalogueSchema.parse(draft);await db.catalogueEntry.upsert({where:{slug:data.slug},create:data,update:{}});}console.log('Draft catalogue entries added. Existing edits and publication decisions were preserved. Confirm every entry in the admin before publishing.');}finally{await db.$disconnect();}
