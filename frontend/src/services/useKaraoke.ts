export function useKaraoke() {
  const submitMockScore = () => Math.floor(60 + Math.random() * 40);
  return { submitMockScore };
}
