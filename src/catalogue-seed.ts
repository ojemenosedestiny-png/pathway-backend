import type { PrismaClient } from "@prisma/client";
import { log } from "./core.js";

/**
 * Owner-requested UK destinations (27 October 2026). Runs once per database: the lock means
 * staff can later edit, unpublish or delete these records without them coming back.
 * Tuition is left at 0 and deadlines empty on purpose; the website then tells visitors to
 * confirm current fees and dates with the university instead of showing invented figures.
 */
export const ukUniversities = [
  {
    name: "University of Stirling",
    description:
      "A public university in Stirling, Scotland, founded in 1967. Its campus sits in the Airthrey estate beside Airthrey Loch, below the Ochil Hills, and is known for sport, business, psychology, nursing and computing.",
    entryRequirements: {
      "How to apply": "Undergraduate applications are made through UCAS. Our advisers help you prepare your application and documents.",
      "Typical qualifications": "A Levels, or WAEC/NECO results with a foundation year where required, plus English language evidence such as IELTS. Grades and English scores differ by course.",
      "Official website": "https://www.stir.ac.uk",
    },
    image: "/assets/universities/university-of-stirling.webp",
    courses: [
      "BA (Hons) Business Studies",
      "BSc (Hons) Computing Science",
      "BSc (Hons) Psychology",
      "BSc (Hons) Sport and Exercise Science",
      "BSc (Hons) Adult Nursing",
    ],
  },
  {
    name: "Newcastle University",
    description:
      "A public research university in Newcastle upon Tyne, England, and a member of the Russell Group. Its city-centre campus offers programmes across medicine, engineering, business, computing, law and the arts.",
    entryRequirements: {
      "How to apply": "Undergraduate applications are made through UCAS. Our advisers help you prepare your application and documents.",
      "Typical qualifications": "A Levels, or WAEC/NECO results with a foundation year where required, plus English language evidence such as IELTS. Grades and English scores differ by course.",
      "Official website": "https://www.ncl.ac.uk",
    },
    image: "/assets/universities/newcastle-university.webp",
    courses: [
      "MBBS Medicine and Surgery",
      "BSc (Hons) Computer Science",
      "BA (Hons) Business Management",
      "MEng (Hons) Civil Engineering",
      "LLB (Hons) Law",
    ],
  },
] as const;

const LOCK = "catalogue:uk-universities:v1";

export async function ensureUkUniversities(db: PrismaClient) {
  if (await db.databaseLock.findUnique({ where: { key: LOCK } })) return;
  const countries = await db.country.findMany();
  let country = countries.find((row) => /^united\s*kingdom$|^uk$/i.test(row.name.trim()));
  if (!country)
    country = await db.country.create({ data: { name: "United Kingdom", code: "GB", featured: true } });
  const existing = await db.university.findMany({ select: { name: true } });
  for (const university of ukUniversities) {
    if (existing.some((row) => row.name.trim().toLowerCase() === university.name.toLowerCase())) continue;
    const created = await db.university.create({
      data: {
        countryId: country.id,
        name: university.name,
        description: university.description,
        entryRequirements: university.entryRequirements,
        tuitionMinor: 0n,
        currency: "USD",
        featured: true,
        active: true,
        image: university.image,
      },
    });
    for (const name of university.courses)
      await db.course.create({
        data: { universityId: created.id, name, tuitionMinor: 0n, currency: "USD", active: true, requirements: {} },
      });
    log.info({ university: university.name }, "Catalogue destination added");
  }
  await db.databaseLock.upsert({ where: { key: LOCK }, create: { key: LOCK, version: 0 }, update: {} });
}
