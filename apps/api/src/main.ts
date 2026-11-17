import 'reflect-metadata';
import { ConsoleLogger, Controller, Get, Module, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { prisma } from '@cadencedesk/data';

@Controller('health')
class HealthController {
  @Get()
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await prisma.workspace.findFirst({ select: { id: true } });
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
  }
}

@Module({ controllers: [HealthController] })
class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await prisma.$disconnect();
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new ConsoleLogger({ json: true }) });
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  const openApi = new DocumentBuilder().setTitle('CadenceDesk API').setVersion('0.1').build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, openApi));
  await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
}

void bootstrap().catch((error: unknown) => {
  console.error('API startup failed', error);
  process.exitCode = 1;
});
