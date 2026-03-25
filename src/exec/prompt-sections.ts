export interface PromptSection {
  title: string;
  content: string;
}

export function renderPromptWithSections(prompt: string, sections: PromptSection[]): string {
  const blocks: string[] = [];
  const trimmedPrompt = prompt.trim();
  if (trimmedPrompt.length > 0) {
    blocks.push(trimmedPrompt);
  }

  for (const section of sections) {
    const title = section.title.trim();
    const content = section.content.trim();
    if (title.length === 0 || content.length === 0) {
      continue;
    }
    blocks.push(`## ${title}\n${content}`);
  }

  return blocks.join('\n\n');
}
