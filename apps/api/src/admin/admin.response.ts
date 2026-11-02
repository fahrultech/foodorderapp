import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus } from '../orders/order.entity';
import { SafeUserResponse } from '../common/swagger-response-models';

export class AdminUserCountsResponse {
  @ApiProperty({ type: 'integer' }) total: number;
  @ApiProperty({ type: 'integer' }) customer: number;
  @ApiProperty({ type: 'integer' }) owner: number;
  @ApiProperty({ type: 'integer' }) admin: number;
}

export class AdminRestaurantCountsResponse {
  @ApiProperty({ type: 'integer' }) total: number;
  @ApiProperty({ type: 'integer' }) open: number;
}

export class AdminOrderCountsResponse {
  @ApiProperty({ type: 'integer' }) total: number;
  @ApiProperty({ type: 'integer' }) pending: number;
  @ApiProperty({ type: 'integer' }) confirmed: number;
  @ApiProperty({ type: 'integer' }) preparing: number;
  @ApiProperty({ type: 'integer' }) delivering: number;
  @ApiProperty({ type: 'integer' }) completed: number;
  @ApiProperty({ type: 'integer' }) cancelled: number;
}

export class AdminPlatformCountsResponse {
  @ApiProperty({ type: () => AdminUserCountsResponse }) users: AdminUserCountsResponse;
  @ApiProperty({ type: () => AdminRestaurantCountsResponse }) restaurants: AdminRestaurantCountsResponse;
  @ApiProperty({ type: () => AdminOrderCountsResponse }) orders: AdminOrderCountsResponse;
}

export class AdminRestaurantRowResponse {
  @ApiProperty({ type: 'string', format: 'uuid' }) id: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiProperty({ type: 'string', format: 'uuid', nullable: true }) ownerId: string | null;
  @ApiProperty({ type: 'string', nullable: true }) ownerName: string | null;
  @ApiProperty({ type: 'string', nullable: true }) city: string | null;
  @ApiProperty() isOpen: boolean;
  @ApiProperty({ type: 'number' }) rating: number;
  @ApiProperty({ type: 'string', format: 'date-time' }) createdAt: string;
}

export class AdminOrderRowResponse {
  @ApiProperty({ type: 'string', format: 'uuid' }) id: string;
  @ApiProperty() code: string;
  @ApiProperty({ enum: OrderStatus }) status: OrderStatus;
  @ApiProperty({ type: 'integer', description: 'Server-computed order total in cents.' }) totalCents: number;
  @ApiProperty() customerName: string;
  @ApiProperty({ type: 'string', format: 'uuid', nullable: true }) userId: string | null;
  @ApiProperty({ type: 'string', format: 'uuid' }) restaurantId: string;
  @ApiProperty({ type: 'string', nullable: true }) restaurantName: string | null;
  @ApiProperty({ type: 'string', format: 'date-time' }) createdAt: string;
}

export class AdminOverviewResponse {
  @ApiProperty({ type: () => AdminPlatformCountsResponse }) counts: AdminPlatformCountsResponse;
  @ApiProperty({ type: () => [SafeUserResponse], description: 'Ten newest accounts; password hashes never leave the service.' })
  recentUsers: SafeUserResponse[];
  @ApiProperty({ type: () => [AdminRestaurantRowResponse], description: 'Ten newest restaurants.' })
  recentRestaurants: AdminRestaurantRowResponse[];
  @ApiProperty({ type: () => [AdminOrderRowResponse], description: 'Twenty newest orders.' })
  recentOrders: AdminOrderRowResponse[];
}
