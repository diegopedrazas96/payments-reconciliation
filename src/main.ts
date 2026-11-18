import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.listen(Number(process.env.PORT ?? 3000));
  // eslint-disable-next-line no-console
  console.log(`listening on :${process.env.PORT ?? 3000} — POST /ingest, GET /balances, GET /breaks`);
}
bootstrap();
