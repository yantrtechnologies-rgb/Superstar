import { createTransport, type Transporter } from 'nodemailer';
import { Body, Button, Container, Head, Html, Preview, render, Text } from 'react-email';
import { Resend } from 'resend';
import { emailConfig } from './auth-config';

let transport: Transporter | undefined;

export async function deliverEmail(to: string, subject: string, heading: string, message: string, url: string, button: string) {
  const config = emailConfig();
  if (!config) throw new Error('Email delivery is unavailable');
  const text = `${heading}\n\n${message}\n\n${button}: ${url}`;
  const body = (
      <Html lang="en">
        <Head />
        <Preview>{heading}</Preview>
        <Body style={{ backgroundColor: '#f6f5f0', fontFamily: 'Arial, sans-serif', color: '#202623' }}>
          <Container style={{ padding: '32px', backgroundColor: '#ffffff' }}>
            <Text style={{ fontWeight: 'bold' }}>Superstar</Text>
            <Text style={{ fontSize: '24px', fontWeight: 'bold' }}>{heading}</Text>
            <Text>{message}</Text>
            <Button href={url} style={{ backgroundColor: '#acf0d3', color: '#153c2f', padding: '12px 18px' }}>
              {button}
            </Button>
          </Container>
        </Body>
      </Html>
  );
  if (config.smtp) {
    transport ??= createTransport(config.smtp);
    try {
      await transport.sendMail({ from: config.from, to, subject, text, html: await render(body) });
    } catch (error) {
      console.error(JSON.stringify({ event: 'email.smtp-failed', code: (error as { code?: string }).code, message: error instanceof Error ? error.message : String(error) }));
      throw new Error('Email delivery was rejected');
    }
    return;
  }
  const { error } = await new Resend(config.apiKey).emails.send({ from: config.from, to, subject, text, react: body });
  if (error) throw new Error('Email delivery was rejected');
}
