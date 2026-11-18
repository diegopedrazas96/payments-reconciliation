import { Module } from '@nestjs/common';
import { DatabaseService } from './db/database.service';
import { IngestService } from './ingest/ingest.service';
import { LedgerService } from './ledger/ledger.service';
import { ReconService } from './recon/recon.service';
import { ReportService } from './report/report.service';
import { ReportController } from './report/report.controller';

@Module({
  controllers: [ReportController],
  providers: [
    { provide: DatabaseService, useFactory: () => new DatabaseService() },
    IngestService,
    LedgerService,
    ReconService,
    ReportService,
  ],
})
export class AppModule {}
