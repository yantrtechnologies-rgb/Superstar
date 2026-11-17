import 'reflect-metadata';
import { ConsoleLogger, Controller, Get, Module, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { prisma } from '@cadencedesk/data';
import { ApiRateLimit } from './api-rate-limit';
import { WorkspaceApiController } from './workspace-api';
import { WorkspaceApiGuard } from './workspace-api-guard';

@Controller('health')
class HealthController {
  constructor(private readonly rateLimit: ApiRateLimit) {}

  @Get()
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await prisma.workspace.findFirst({ select: { id: true } });
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
    if (!this.rateLimit.ready()) throw new ServiceUnavailableException('Rate limit cache unavailable');
    return { status: 'ready' };
  }
}

@Module({ controllers: [HealthController, WorkspaceApiController], providers: [ApiRateLimit, WorkspaceApiGuard] })
class AppModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await prisma.$disconnect();
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new ConsoleLogger({ json: true }) });
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  const openApi = new DocumentBuilder().setTitle('CadenceDesk API').setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'Workspace API key' }, 'WorkspaceKey')
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, openApi));
  await app.listen(Number(process.env.PORT ?? 3001), process.env.API_LISTEN_HOST ?? '0.0.0.0');
}

void bootstrap().catch((error: unknown) => {
  console.error('API startup failed', error);
  process.exitCode = 1;
});
