import { Test, TestingModule } from '@nestjs/testing';
import { TodosService } from './todos.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import * as sanitizeHtml from 'sanitize-html';

jest.mock('sanitize-html', () => jest.fn((input) => `sanitized:${input}`));

describe('TodosService', () => {
  let service: TodosService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TodosService,
        {
          provide: PrismaService,
          useValue: {
            todo: {
              create: jest.fn(),
              findMany: jest.fn(),
              findUnique: jest.fn(),
              update: jest.fn(),
              delete: jest.fn(),
              deleteMany: jest.fn(),
            },
            $transaction: jest.fn((cb) => cb({
              todo: { create: jest.fn().mockImplementation((data) => data) },
            })),
          },
        },
      ],
    }).compile();

    service = module.get<TodosService>(TodosService);
    prisma = module.get(PrismaService);
  });

  describe('create()', () => {
    it('should throw BadRequestException if title is empty', async () => {
      await expect(service.create({ title: '  ', description: 'test' }, 'user1'))
        .rejects.toThrow(BadRequestException);
    });

    it('should sanitize description and create todo', async () => {
      prisma.todo.create.mockResolvedValue({ id: '1', title: 'Test', description: 'sanitized:desc', ownerId: 'user1' });
      const result = await service.create({ title: 'Test', description: 'desc' }, 'user1');

      expect(prisma.todo.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          title: 'Test',
          description: 'sanitized:desc',
          ownerId: 'user1',
        }),
      }));
      expect(result.id).toBe('1');
    });
  });

  describe('findAll()', () => {
    it('should fetch todos for the user', async () => {
      prisma.todo.findMany.mockResolvedValue([{ id: '1' } as any]);
      const result = await service.findAll('user1', 'all');
      expect(prisma.todo.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { ownerId: 'user1' },
      }));
      expect(result).toEqual([{ id: '1' }]);
    });

    it('should filter by completed status', async () => {
      await service.findAll('user1', 'completed');
      expect(prisma.todo.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { ownerId: 'user1', completed: true },
      }));
    });
  });

  describe('findOne()', () => {
    it('should throw NotFoundException if todo does not exist', async () => {
      prisma.todo.findUnique.mockResolvedValue(null);
      await expect(service.findOne('1', 'user1')).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if user does not own todo', async () => {
      prisma.todo.findUnique.mockResolvedValue({ id: '1', ownerId: 'user2' } as any);
      await expect(service.findOne('1', 'user1')).rejects.toThrow(ForbiddenException);
    });

    it('should return todo if found and owned', async () => {
      prisma.todo.findUnique.mockResolvedValue({ id: '1', ownerId: 'user1' } as any);
      const result = await service.findOne('1', 'user1');
      expect(result.id).toBe('1');
    });
  });

  describe('update()', () => {
    it('should throw ConflictException on version mismatch', async () => {
      jest.spyOn(service, 'findOne').mockResolvedValue({ id: '1', ownerId: 'user1', version: 1 } as any);
      const dto = { version: 2, title: 'Test' };
      await expect(service.update('1', dto, 'user1')).rejects.toThrow(ConflictException);
    });

    it('should sanitize description and update todo', async () => {
      jest.spyOn(service, 'findOne').mockResolvedValue({ id: '1', ownerId: 'user1', version: 1 } as any);
      prisma.todo.update.mockResolvedValue({ id: '1', version: 2 } as any);
      const result = await service.update('1', { version: 1, description: 'dirty' }, 'user1');

      expect(prisma.todo.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          description: 'sanitized:dirty',
          version: 2,
        }),
      }));
      expect(result.version).toBe(2);
    });
  });

  describe('remove()', () => {
    it('should call delete after ownership check', async () => {
      jest.spyOn(service, 'findOne').mockResolvedValue({ id: '1', ownerId: 'user1' } as any);
      await service.remove('1', 'user1');
      expect(prisma.todo.delete).toHaveBeenCalledWith({ where: { id: '1' } });
    });
  });

  describe('bulkCreate()', () => {
    it('should throw if any todo title is empty', async () => {
      const dto = { todos: [{ title: '', description: 'x' }] };
      await expect(service.bulkCreate(dto as any, 'user1')).rejects.toThrow(BadRequestException);
    });

    it('should create multiple todos in transaction', async () => {
      const dto = { todos: [{ title: 'A' }, { title: 'B' }] };
      const result = await service.bulkCreate(dto as any, 'user1');
      expect(result.length).toBe(2);
      expect(sanitizeHtml).toHaveBeenCalled();
    });
  });

  describe('bulkDelete()', () => {
    it('should delete only user-owned todos', async () => {
      prisma.todo.findMany.mockResolvedValue([{ id: '1' } as any]);
      prisma.todo.deleteMany.mockResolvedValue({ count: 1 } as any);

      const result = await service.bulkDelete({ ids: ['1', '2'] }, 'user1');
      expect(result.deleted).toEqual(['1']);
      expect(result.notFound).toEqual(['2']);
    });
  });
});
