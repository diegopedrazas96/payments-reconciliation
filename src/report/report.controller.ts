import { Body, Controller, Get, Post } from '@nestjs/common';
import { ReconService } from '../recon/recon.service';
import { ReportService } from './report.service';
import { DATA_DIR_DEFAULT } from '../constants';

@Controller()
export class ReportController {
  constructor(
    private readonly recon: ReconService,
    private readonly report: ReportService,
  ) {}

  /** Ingest (or re-ingest — idempotent) the data directory and reconcile. */
  @Post('ingest')
  ingest(@Body() body?: { dir?: string }): { ok: true; balances: unknown } {
    this.recon.reconcile(body?.dir ?? DATA_DIR_DEFAULT);
    return { ok: true, balances: this.report.balances() };
  }

  @Get('balances')
  balances() {
    return this.report.balances();
  }

  @Get('breaks')
  breaks() {
    return this.report.breaks();
  }
}
