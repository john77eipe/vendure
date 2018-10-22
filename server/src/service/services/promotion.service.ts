import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import {
    AdjustmentOperation,
    AdjustmentOperationInput,
    CreatePromotionInput,
    UpdatePromotionInput,
} from 'shared/generated-types';
import { omit } from 'shared/omit';
import { ID, PaginatedList } from 'shared/shared-types';
import { Connection } from 'typeorm';

import { RequestContext } from '../../api/common/request-context';
import { ListQueryOptions } from '../../common/types/common-types';
import { assertFound } from '../../common/utils';
import { ConfigService } from '../../config/config.service';
import { PromotionAction } from '../../config/promotion/promotion-action';
import { PromotionCondition } from '../../config/promotion/promotion-condition';
import { Promotion } from '../../entity/promotion/promotion.entity';
import { I18nError } from '../../i18n/i18n-error';
import { ListQueryBuilder } from '../helpers/list-query-builder/list-query-builder';
import { patchEntity } from '../helpers/utils/patch-entity';

import { ChannelService } from './channel.service';

@Injectable()
export class PromotionService {
    availableConditions: PromotionCondition[] = [];
    availableActions: PromotionAction[] = [];
    /**
     * All active AdjustmentSources are cached in memory becuase they are needed
     * every time an order is changed, which will happen often. Caching them means
     * a DB call is not required newly each time.
     */
    private activePromotions: Promotion[] = [];

    constructor(
        @InjectConnection() private connection: Connection,
        private configService: ConfigService,
        private channelService: ChannelService,
        private listQueryBuilder: ListQueryBuilder,
    ) {
        this.availableConditions = this.configService.promotionConditions;
        this.availableActions = this.configService.promotionActions;
    }

    findAll(options?: ListQueryOptions<Promotion>): Promise<PaginatedList<Promotion>> {
        return this.listQueryBuilder
            .build(Promotion, options)
            .getManyAndCount()
            .then(([items, totalItems]) => ({
                items,
                totalItems,
            }));
    }

    async findOne(adjustmentSourceId: ID): Promise<Promotion | undefined> {
        return this.connection.manager.findOne(Promotion, adjustmentSourceId, {});
    }

    /**
     * Returns all available AdjustmentOperations.
     */
    getAdjustmentOperations(): {
        conditions: AdjustmentOperation[];
        actions: AdjustmentOperation[];
    } {
        const toAdjustmentOperation = (source: PromotionCondition | PromotionAction) => {
            return {
                code: source.code,
                description: source.description,
                args: Object.entries(source.args).map(([name, type]) => ({ name, type })),
            };
        };
        return {
            conditions: this.availableConditions.map(toAdjustmentOperation),
            actions: this.availableActions.map(toAdjustmentOperation),
        };
    }

    /**
     * Returns all active AdjustmentSources.
     */
    async getActivePromotions(): Promise<Promotion[]> {
        if (!this.activePromotions.length) {
            await this.updatePromotions();
        }
        return this.activePromotions;
    }

    async createPromotion(ctx: RequestContext, input: CreatePromotionInput): Promise<Promotion> {
        const adjustmentSource = new Promotion({
            name: input.name,
            enabled: input.enabled,
            conditions: input.conditions.map(c => this.parseOperationArgs('condition', c)),
            actions: input.actions.map(a => this.parseOperationArgs('action', a)),
        });
        this.channelService.assignToChannels(adjustmentSource, ctx);
        const newAdjustmentSource = await this.connection.manager.save(adjustmentSource);
        await this.updatePromotions();
        return assertFound(this.findOne(newAdjustmentSource.id));
    }

    async updatePromotion(ctx: RequestContext, input: UpdatePromotionInput): Promise<Promotion> {
        const adjustmentSource = await this.connection.getRepository(Promotion).findOne(input.id);
        if (!adjustmentSource) {
            throw new I18nError(`error.entity-with-id-not-found`, {
                entityName: 'AdjustmentSource',
                id: input.id,
            });
        }
        const updatedAdjustmentSource = patchEntity(adjustmentSource, omit(input, ['conditions', 'actions']));
        if (input.conditions) {
            updatedAdjustmentSource.conditions = input.conditions.map(c =>
                this.parseOperationArgs('condition', c),
            );
        }
        if (input.actions) {
            updatedAdjustmentSource.actions = input.actions.map(a => this.parseOperationArgs('action', a));
        }
        await this.connection.manager.save(updatedAdjustmentSource);
        await this.updatePromotions();
        return assertFound(this.findOne(updatedAdjustmentSource.id));
    }

    /**
     * Converts the input values of the "create" and "update" mutations into the format expected by the AdjustmentSource entity.
     */
    private parseOperationArgs(
        type: 'condition' | 'action',
        input: AdjustmentOperationInput,
    ): AdjustmentOperation {
        const match = this.getAdjustmentOperationByCode(type, input.code);
        const output: AdjustmentOperation = {
            code: input.code,
            description: match.description,
            args: input.arguments.map((inputArg, i) => {
                return {
                    name: inputArg.name,
                    type: match.args[inputArg.name],
                    value: inputArg.value,
                };
            }),
        };
        return output;
    }

    private getAdjustmentOperationByCode(
        type: 'condition' | 'action',
        code: string,
    ): PromotionCondition | PromotionAction {
        const available: Array<PromotionAction | PromotionCondition> =
            type === 'condition' ? this.availableConditions : this.availableActions;
        const match = available.find(a => a.code === code);
        if (!match) {
            throw new I18nError(`error.adjustment-operation-with-code-not-found`, { code });
        }
        return match;
    }

    /**
     * Update the activeSources cache.
     */
    private async updatePromotions() {
        this.activePromotions = await this.connection.getRepository(Promotion).find({
            where: { enabled: true },
        });
    }
}