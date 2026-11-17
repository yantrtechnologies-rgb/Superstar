import { Body, Button, Container, Head, Html, Preview, Text } from 'react-email';
import { Resend } from 'resend';
import { emailConfig } from './auth-config';

export async function deliverEmail(to: string, subject: string, heading: string, message: string, url: string, button: string) {
  const config = emailConfig();
  if (!config) throw new Error('Email delivery is unavailable');
  const { error } = await new Resend(config.apiKey).emails.send({
    from: config.from,
    to,
    subject,
    text: `${heading}\n\n${message}\n\n${button}: ${url}`,
    react: (
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
    ),
  });
  if (error) throw new Error('Email delivery was rejected');
}
