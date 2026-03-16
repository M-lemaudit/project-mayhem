interface HeadProps {
  params: { id: string };
}

export default function Head({ params }: HeadProps) {
  const shortId = params.id.slice(0, 6);

  return (
    <>
      <title>Account {shortId} – Chauffeur Elite</title>
    </>
  );
}

