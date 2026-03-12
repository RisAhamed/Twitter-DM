import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const DEFAULT_MODEL = 'openai/gpt-oss-120b';

export async function generateMessage({ name, bio, campaignContext, ctaLink, model }) {
  const useModel = model || DEFAULT_MODEL;

  const systemPrompt = `You are a friendly outreach copywriter. Write a casual, friendly 2-3 sentence Twitter DM.
Rules:
- Mention something specific from the recipient's bio to show genuine interest.
- Subtly pitch the following service: ${campaignContext}
- End the message by naturally sharing this link: ${ctaLink}
- Do NOT be overly formal or salesy.
- Do NOT use hashtags or emojis.
- Keep it under 500 characters.
- Return ONLY the DM text — no quotes, no preamble, no explanation.`;

  const userPrompt = `Recipient name: ${name}\nRecipient bio: ${bio}`;

  const response = await groq.chat.completions.create({
    model: useModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.8,
    max_tokens: 300,
  });

  const text = response.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Groq returned empty message');
  return text;
}
