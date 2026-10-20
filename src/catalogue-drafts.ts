const disclaimer='Intakes and requirements vary by university. An adviser will confirm the details for you.';
const examNotice='Official registration is processed through the relevant exam body or approved centre.';
const provision='Preparation classes, mock exams, registration support and adviser guidance. Confirm availability with the school.';
export const catalogueDrafts=[
 ...[
 ['united-kingdom','United Kingdom','GB','Foundation or A-level/IGCSE routes can support progression towards undergraduate study.','Foundation or A-level/IGCSE route','September; some January and May intakes'],
 ['canada','Canada','CA','A strong high-school record and evidence of English proficiency are important starting points.','School qualifications and institution-specific language requirements','September, January and some May intakes'],
 ['united-states','United States','US','Build a broad application profile and check whether SAT or equivalent testing is required.','School qualifications, application profile and any required tests','August/September (fall); January (spring)'],
 ['united-arab-emirates','United Arab Emirates','AE','Explore international campuses and foundation programmes for your intended course.','Foundation or direct entry, depending on the institution','September and January/February'],
 ].map(([slug,name,countryCode,summary,route,intakes],order)=>({slug,kind:'DESTINATION',name,countryCode,summary,route,intakes,disclaimer,image:'/assets/university-campus.jpg',order,status:'DRAFT'})),
 ...[
 ['waec-ssce','WAEC (SSCE)','Nigerian','Senior secondary','Students preparing for the West African Senior School Certificate Examination.'],
 ['neco-ssce','NECO (SSCE)','Nigerian','Senior secondary','Students preparing for the National Examinations Council Senior School Certificate Examination.'],
 ['cambridge-international','Cambridge International','Cambridge','Checkpoint, IGCSE, AS and A Level','Students exploring Cambridge qualifications appropriate to their stage of study.'],
 ['bece','BECE','Nigerian','Junior secondary','Students preparing to complete junior secondary education.'],
 ['sat','SAT','', 'University admissions testing','Applicants whose chosen institutions require or consider SAT results.'],
 ['hmb-pre-degree','HMB (Pre-Degree)','Pre-degree','Pre-degree','Applicants exploring preparation before undergraduate study.'],
 ].map(([slug,name,category,level,whoFor],order)=>({slug,kind:'EXAM',name,category,level,whoFor,summary:whoFor,provision,disclaimer:examNotice,amountMinor:null,deadline:null,requiredDocuments:['Passport photograph','Previous results'],order,status:'DRAFT'})),
 ...['Female residence','Male residence','Mixed residence'].map((label,order)=>({slug:'demo-hostel-'+(order+1),kind:'HOSTEL',name:'DEMO — '+label,summary:'Demonstration accommodation card. Confirm actual rooms, fees and availability with the school.',image:'/assets/hostel-demo-'+(order+1)+'.svg',gender:['FEMALE','MALE','MIXED'][order],roomType:'Room type to be confirmed',availability:'Demo — not bookable',amountMinor:null,demo:true,disclaimer:'Illustrative image. This demo is not an available room or a booking offer.',order,status:'DRAFT'})),
];
