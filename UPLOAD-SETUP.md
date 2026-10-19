# Direct file uploads

The admin media library accepts JPG, PNG, WebP and PDF (10 MiB), and MP4/WebM videos (50 MiB).
Room photos, carousel images and university pictures can be selected from the device or approved media library.
Images are attached only after server validation and scanning. The existing student document flow stays private.

## Setup order

1. Create a Cloudflare account and enable R2 Object Storage. Review any billing prompt before accepting.
2. Create a **private** bucket named `pathway-files`. Keep public development access disabled.
   This bucket contains `quarantine/`, `private/` and `public/` objects. Never expose the whole bucket.
3. Create R2 S3 credentials scoped to object read/write for that bucket. Copy keys directly into Render backend environment variables, never chat or GitHub.
4. Configure a public media gateway that serves **only `public/` keys** from this private bucket.
   Student documents and quarantine keys must return 404. Set its HTTPS base URL as `PUBLIC_MEDIA_BASE`.
   Alternatively use infrastructure with a public-read policy restricted to the `public/` prefix.
5. Set up an authenticated malware scanner: `POST` raw bytes with `Authorization: Bearer SCANNER_TOKEN`, returning `{"clean":true}` only after actual scanning, or `{"clean":false}` for rejected files.
   It must support the allowed file sizes. Do not use a dummy success endpoint.
6. On the backend Render service set:

```dotenv
S3_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=pathway-files
S3_ACCESS_KEY=YOUR_PRIVATE_ACCESS_KEY
S3_SECRET_KEY=YOUR_PRIVATE_SECRET_KEY
PUBLIC_MEDIA_BASE=https://YOUR_PUBLIC_PREFIX_ONLY_GATEWAY
SCANNER_URL=https://YOUR_SCANNER_ENDPOINT
SCANNER_TOKEN=YOUR_PRIVATE_SCANNER_TOKEN
RUN_WORKER_IN_API=true
```

7. Bucket CORS must permit the frontend's origin to upload via signed URLs:

```json
[
  {
    "AllowedOrigins": ["https://pathway-frontend-hy8e.onrender.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

8. On the **frontend** Render service set `PATHWAY_UPLOAD_ORIGIN` to the R2 S3 origin
   and `PATHWAY_MEDIA_ORIGIN` to the public gateway origin, then redeploy both services.
9. Test Admin → Media library → Upload media. Check scanning reaches APPROVED.
   In a room photo editor choose a file, wait for approval, then save the room.
   Also verify a private document cannot be fetched from the public gateway.

## API additions

`POST /files/upload-url` uses the existing request shape `{filename,mime,size,type,public,ownerId?}`.
The expanded MIME allowlist includes `image/webp`, `video/mp4` and `video/webm`.
Videos require `type: "MEDIA"` and `public: true`, checked with content permissions.
Response: `{id,uploadUrl,expiresIn:300,headers:{"Content-Type":mime}}`.
PUT the exact file bytes to `uploadUrl`; call `POST /files/:id/complete` with `{}`.

`GET /files/:id/status` requires authentication. Owners can inspect their files;
admins with media read/write permission can inspect public media. Response:
`{id,filename,mime,status,url}`. `url` is null unless this is approved public media.
Quarantine keys are never returned. Existing signed downloads remain permission checked.

Uploads report setup errors before creating records when scanner/public delivery is unconfigured.
Browser tests use synthetic storage; a real delivery test requires the external services above.
