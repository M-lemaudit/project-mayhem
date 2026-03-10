import fs from 'fs';
import path from 'path';

export const dynamic = 'force-static';

function getHtml() {
  const filePath = path.join(process.cwd(), 'stitch', 'advanced-account-control-ok.html');
  return fs.readFileSync(filePath, 'utf8');
}

export default function AdvancedAccountControlPage() {
  const html = getHtml();

  return (
    <div
      // This renders the Stitch-generated HTML exactly as-is
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

